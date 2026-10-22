// Excerpt from the production codebase (src/lib/daily-menu.ts), shared here
// as a representative, self-contained sample. Imports below refer to sibling
// modules in the private repo (the Prisma client, and pure helpers like
// `lagosDay`/`dailyMenuProblems`) and won't resolve standalone — this file
// is for reading, not running. See the root README's "Engineering
// Challenges & Solutions" section for the concurrency problem this solves.

import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { dailyMenuProblems, lagosDay, lagosDayRange, resolveDayItem, type DailyMenuProblem, type DayMenu } from "@/components/daily-menu/rules";

type Db = typeof prisma | Prisma.TransactionClient;

/**
 * Portions of each dish on non-cancelled orders whose business day is `day`
 * — the Lagos date of dueAt, or of createdAt when there's no due time.
 */
export async function soldByItem(day: string, opts: { menuItemIds?: string[]; db?: Db } = {}): Promise<Map<string, number>> {
  const { start, end } = lagosDayRange(day);
  const rows = await (opts.db ?? prisma).orderItem.groupBy({
    by: ["menuItemId"],
    where: {
      menuItemId: opts.menuItemIds ? { in: opts.menuItemIds } : { not: null },
      order: {
        status: { not: "CANCELLED" },
        OR: [{ dueAt: { gte: start, lt: end } }, { dueAt: null, createdAt: { gte: start, lt: end } }],
      },
    },
    _sum: { quantity: true },
  });
  return new Map(rows.filter((r) => r.menuItemId).map((r) => [r.menuItemId!, r._sum.quantity ?? 0]));
}

/**
 * Checks order lines against the menu of the order's business day.
 * Pass `lock: true` inside a transaction to lock that day's rows for these
 * dishes FIRST — so two orders racing for the last portions of a
 * limited-batch dish are checked one after the other, never both reading
 * the same "portions remaining" count and both succeeding.
 */
export async function checkDailyMenu(
  lines: { menuItemId?: string | null; quantity: number; name?: string | null }[],
  opts: { dueAt?: Date | null; db?: Db; lock?: boolean } = {},
): Promise<{ day: string; problems: DailyMenuProblem[] }> {
  const day = lagosDay(opts.dueAt ?? new Date());
  const ids = [...new Set(lines.map((l) => l.menuItemId).filter((id): id is string => !!id))];
  if (ids.length === 0) return { day, problems: [] };
  const db = opts.db ?? prisma;

  if (opts.lock) {
    // Row-level lock, scoped to exactly this day's rows for exactly these
    // dishes — unrelated dishes and unrelated days never contend with each
    // other. A second transaction hitting this line blocks until the first
    // commits, so it re-reads an up-to-date "sold so far" count below.
    await db.$queryRaw`SELECT "id" FROM "DailyMenuItem" WHERE "day" = ${day} AND "menuItemId" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`;
  }

  const menu = await getDayMenu(day, { menuItemIds: ids, db });
  return { day, problems: dailyMenuProblems(menu, lines) };
}

async function getDayMenu(day: string, opts: { menuItemIds?: string[]; db?: Db } = {}): Promise<DayMenu> {
  const db = opts.db ?? prisma;
  const [items, rows, sold] = await Promise.all([
    db.menuItem.findMany({
      where: { isActive: true, ...(opts.menuItemIds ? { id: { in: opts.menuItemIds } } : {}) },
      select: { id: true, name: true, category: true, priceKobo: true, imageUrl: true, availableOnline: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    db.dailyMenuItem.findMany({
      where: { day, ...(opts.menuItemIds ? { menuItemId: { in: opts.menuItemIds } } : {}) },
      select: { menuItemId: true, available: true, quantity: true },
    }),
    soldByItem(day, opts),
  ]);
  const isSet = rows.length > 0;
  const rowById = new Map(rows.map((r) => [r.menuItemId, r]));
  return {
    day,
    isSet,
    items: items.map((m) => ({
      menuItemId: m.id,
      name: m.name,
      category: m.category,
      priceKobo: m.priceKobo,
      imageUrl: m.imageUrl,
      availableOnline: m.availableOnline,
      ...resolveDayItem(isSet, rowById.get(m.id), sold.get(m.id) ?? 0),
    })),
  };
}
