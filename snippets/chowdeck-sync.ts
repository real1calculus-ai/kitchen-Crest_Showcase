// Excerpt from the production codebase (src/lib/chowdeck.ts), shared here as
// a representative, self-contained sample. Imports below (`@/lib/orders`,
// `@/lib/prisma`, `@/lib/constants`) refer to sibling modules in the private
// repo and won't resolve standalone — this file is for reading, not running.

import "server-only";
import { prisma } from "@/lib/prisma";
import { createOrder, setOrderStatus, OrderInputError } from "@/lib/orders";
import type { OrderStatus } from "@/lib/constants";

/**
 * Chowdeck merchant API — read-only order sync.
 *
 * We pull orders (id, status, total, customer address) with GET
 * /:merchantReference/order and mirror them into our own Order table as the
 * CHOWDECK channel, keyed by externalRef so re-syncing never duplicates.
 *
 * Chowdeck's list endpoint has no line-item detail (no webhook/item API is
 * set up yet either), so synced orders land as one line priced at the
 * order's total and flagged needsReview. That's fine here: production cost
 * is tracked as a batch expense, not per-dish recipe deduction, so no
 * ingredient-stock math depends on knowing the individual dishes.
 *
 * Docs: https://chowdeck-api.readme.io/ (Order section). Endpoint paths are
 * copied verbatim including the doubled slash before the merchant
 * reference — that's how Chowdeck's own examples are written.
 */

const CHOWDECK_BASE = "https://api.chowdeck.com";

export type ChowdeckOrder = {
  id: number;
  vendor_name: string;
  vendor_id: number;
  vendor_location: string;
  support_phone_number: string;
  total_price: number; // kobo, same smallest-unit convention we use
  created_at: string;
  status: string;
  updated_at: string;
  customer_address: string;
  vendor_address: string;
  class: string; // e.g. "delivery"
};

type ChowdeckOrdersResponse = {
  status: string;
  message: string;
  data: ChowdeckOrder[];
  meta: { total: number; current_page: number; total_pages: number; per_page: number };
};

function config(): { apiKey: string; merchantRef: string } | null {
  const apiKey = process.env.CHOWDECK_API_KEY?.trim();
  const merchantRef = process.env.CHOWDECK_MERCHANT_REF?.trim();
  if (!apiKey || !merchantRef) return null;
  return { apiKey, merchantRef };
}

export function chowdeckConfigured(): boolean {
  return config() !== null;
}

/** Maps Chowdeck's order status to ours. Unrecognised statuses fall back to PENDING + a flag, never a crash. */
export function mapChowdeckStatus(status: string): { status: OrderStatus; recognised: boolean } {
  switch (status.toLowerCase()) {
    case "received":
    case "pending":
      return { status: "PENDING", recognised: true };
    case "preparing":
      return { status: "PREPARING", recognised: true };
    case "awaiting_pickup":
    case "in_transit":
      return { status: "READY", recognised: true };
    case "success":
    case "completed":
    case "delivered":
      return { status: "COMPLETED", recognised: true };
    case "rejected":
    case "cancelled":
    case "canceled":
      return { status: "CANCELLED", recognised: true };
    default:
      return { status: "PENDING", recognised: false };
  }
}

class ChowdeckApiError extends Error {}

async function fetchOrdersPage(
  cfg: { apiKey: string; merchantRef: string },
  { page, perPage, startDate }: { page: number; perPage: number; startDate: string },
): Promise<ChowdeckOrdersResponse> {
  const url = new URL(`${CHOWDECK_BASE}//${cfg.merchantRef}/order`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("start_date", startDate);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ChowdeckApiError(`Chowdeck API ${res.status}: ${body.slice(0, 300) || res.statusText}`);
  }
  return res.json() as Promise<ChowdeckOrdersResponse>;
}

/** Fetches every order since `startDate` (YYYY-MM-DD), across pages, capped for safety. */
async function fetchAllOrders(cfg: { apiKey: string; merchantRef: string }, startDate: string): Promise<ChowdeckOrder[]> {
  const perPage = 100;
  const MAX_PAGES = 20; // 2,000 orders per sync run — plenty of headroom for a small vendor
  const first = await fetchOrdersPage(cfg, { page: 1, perPage, startDate });
  const all = [...first.data];
  const totalPages = Math.min(first.meta.total_pages, MAX_PAGES);
  for (let page = 2; page <= totalPages; page++) {
    const next = await fetchOrdersPage(cfg, { page, perPage, startDate });
    all.push(...next.data);
  }
  return all;
}

export type ChowdeckSyncResult = {
  fetched: number;
  created: number;
  statusUpdated: number;
  unchanged: number;
  errors: string[];
};

/**
 * Pulls recent Chowdeck orders and mirrors them into our Order table.
 * Safe to run repeatedly (e.g. a "Sync now" button, or a cron once deployed)
 * — existing orders are matched by externalRef and only their status moves.
 */
export async function syncChowdeckOrders(lookbackDays = 14): Promise<ChowdeckSyncResult> {
  const cfg = config();
  if (!cfg) throw new Error("Chowdeck isn't configured: set CHOWDECK_API_KEY and CHOWDECK_MERCHANT_REF.");

  const startDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const orders = await fetchAllOrders(cfg, startDate);

  const result: ChowdeckSyncResult = { fetched: orders.length, created: 0, statusUpdated: 0, unchanged: 0, errors: [] };

  for (const co of orders) {
    const externalRef = `chowdeck:${co.id}`;
    const mapped = mapChowdeckStatus(co.status);
    try {
      const existing = await findByExternalRef(externalRef);
      if (!existing) {
        await createOrder({
          channel: "CHOWDECK",
          status: mapped.status,
          customer: { address: co.customer_address || null },
          fulfillment: co.class === "delivery" ? "DELIVERY" : "PICKUP",
          deliveryAddress: co.customer_address || null,
          items: [
            {
              name: "Chowdeck order (see Chowdeck dashboard for items)",
              quantity: 1,
              unitPriceKobo: Math.round(co.total_price),
            },
          ],
          rawMessage: JSON.stringify(co),
          needsReview: true,
          reviewNote: mapped.recognised
            ? "Synced from Chowdeck — item breakdown isn't available via the API, so this is one line for the order total. Log production cost as a batch expense as usual."
            : `Synced from Chowdeck with an unrecognised status "${co.status}" — check it matches reality.`,
          externalRef,
        });
        result.created++;
      } else if (existing.status !== mapped.status) {
        await setOrderStatus(existing.id, mapped.status, "chowdeck-sync");
        result.statusUpdated++;
      } else {
        result.unchanged++;
      }
    } catch (e) {
      const message = e instanceof OrderInputError || e instanceof ChowdeckApiError ? e.message : "sync failed";
      result.errors.push(`Order #${co.id}: ${message}`);
    }
  }
  return result;
}

async function findByExternalRef(externalRef: string) {
  return prisma.order.findUnique({ where: { externalRef }, select: { id: true, status: true } });
}
