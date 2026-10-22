# Technical Architecture & System Design

This document details the data model, concurrency control, AI pipeline, and integration design behind Kitchen Crest.

---

## 1. Architectural Principles

1. **One order model, six channels.** Every order — however it arrives — ends up as the same `Order`/`OrderItem` shape, created through a single `createOrder()` path. Channel-specific logic (parsing, matching, marketplace sync) lives upstream of that boundary, never duplicated downstream of it.
2. **Money is always an integer.** Every amount is stored in kobo (the smallest Naira unit) as an integer, never a float, eliminating an entire class of currency rounding bugs.
3. **The database is the source of truth for price, not the customer's message or the AI's reading of it.** Free text only ever selects *which* menu row applies; the row supplies the price.
4. **Concurrency correctness over optimistic assumptions.** Where two channels can race for the same limited resource (portions of a dish), the database enforces ordering explicitly rather than hoping application-level checks are fast enough.

---

## 2. Data Model — Orders, Channels, and Costing

```
      +---------------------------+
      |          MenuItem         |
      |  (name, priceKobo,        |
      |   aliases, category)      |
      +---------------------------+
                  | 1
                  |
                  | N
      +---------------------------+
      |         RecipeLine        |
      |  (menuItemId, ingredientId,|
      |   quantity)                |
      +---------------------------+
                  | N
                  |
                  | 1
      +---------------------------+
      |         Ingredient        |
      |  (costPerUnitKobo,        |
      |   stockQty, unit)          |
      +---------------------------+

      +---------------------------+
      |            Order           |
      |  (channel, status,         |
      |   totalKobo, foodCostKobo, |
      |   externalRef)             |
      +---------------------------+
                  | 1
                  |
                  | N
      +---------------------------+
      |          OrderItem         |
      |  (menuItemId?, name,       |
      |   quantity, unitPriceKobo, |
      |   unitCostKobo — snapshot) |
      +---------------------------+
```

- **Cost is snapshotted, not live-joined.** `OrderItem.unitCostKobo` captures the recipe cost *at order time*, so later ingredient price changes never rewrite historical profit numbers.
- **`channel`** is one of `STAND | PHONE | WHATSAPP | INSTAGRAM | ONLINE | CHOWDECK` — a plain string validated against a constant, not a database enum, so adding a channel (as Chowdeck was) is a one-line change, not a migration.
- **`externalRef`** is a unique, nullable field used by every automated intake path (WhatsApp/Instagram webhook retries, Chowdeck sync) to make order creation idempotent: a redelivered webhook or a re-run sync looks up the existing order instead of creating a duplicate.

---

## 3. Order Ingestion Pipeline

```
  Stand / Phone / Online link            WhatsApp / Instagram DM           Chowdeck marketplace
         |                                        |                                |
         | (structured input)                     | (free text)                    | (polled REST)
         v                                        v                                v
  +-------------+                    +---------------------------+     +--------------------------+
  | Daily-menu  |                    |   Claude structured        |     |  GET /order (list)       |
  | lock + check|                    |   extraction, or regex     |     |  status: received,       |
  +-------------+                    |   fallback if no AI key    |     |  preparing, awaiting_    |
         |                           +---------------------------+     |  pickup, success,        |
         |                                        |                    |  rejected                |
         |                                        v                    +--------------------------+
         |                           +---------------------------+                |
         |                           |  Fuzzy menu-item matcher   |                | map status -> internal
         |                           |  (exact / alias / contains |                | lifecycle; upsert by
         |                           |   / typo-tolerant tokens)  |                | externalRef
         |                           +---------------------------+                |
         |                                        |                                |
         v                                        v                                v
  +------------------------------------------------------------------------------------------+
  |                                   createOrder()                                           |
  |   validates channel/status/items, resolves customer by phone/Instagram, snapshots price    |
  |   and recipe cost per line, allocates an order number, triggers the new-order alert         |
  +------------------------------------------------------------------------------------------+
```

Every arrow into `createOrder()` carries the same contract: a channel, a list of items (menu-linked or custom), and optional customer/fulfillment details. The function doesn't know or care whether the caller was a human filling in a form or an AI-parsed WhatsApp message — which is what keeps six intake surfaces from becoming six slightly-different order-creation implementations.

---

## 4. Portion-Limited Daily Menu & Concurrency Control

Some dishes are capped to a fixed batch size for the day (e.g. "20 portions of jollof today"). Two checkouts racing for the last portion — one at the stand, one online — must not both succeed.

```
  Order A (Stand)              Order B (Online, same dish, same day)
        |                                |
        v                                v
  BEGIN TRANSACTION               BEGIN TRANSACTION
        |                                |
        v                                v
  SELECT ... FOR UPDATE  <-------- blocks until A commits or rolls back
  (locks that day's DailyMenuItem
   rows for the dishes on this order)
        |
        v
  Check portions remaining
  (sold so far vs. the limit)
        |
        v
  Insert order, commit            (now proceeds)
        |                                |
                                          v
                                   Re-check portions remaining
                                   against A's now-committed total
                                          |
                                          v
                                   Reject or accept B accordingly
```

The lock is scoped to exactly the `DailyMenuItem` rows for the dishes on the order being checked — not the whole table — so unrelated dishes and unrelated days never contend with each other.

---

## 5. Chowdeck Marketplace Integration

- **Pull, not push (for now).** Chowdeck's merchant API has no webhook wired up yet and no item-level detail on its order-list endpoint, so orders are pulled on a schedule (`GET /:merchantRef/order`) rather than pushed to us.
- **Idempotent by design.** Each Chowdeck order maps to `externalRef = "chowdeck:<id>"`. A sync run either creates a new order (not seen before) or advances an existing one's status (if Chowdeck's status changed) — never a duplicate, however many times it runs.
- **Defensive status mapping.** Chowdeck's status vocabulary doesn't line up with the app's internal order lifecycle one-to-one; an explicit mapping function translates known statuses and flags anything unrecognized for human review rather than guessing.
- **Scheduling.** A manual "sync now" action in Settings and a scheduled job both call the same sync function — there's exactly one code path for "pull Chowdeck orders," run either on demand or on a timer.

---

## 6. Security

- **Staff authentication**: PIN-based login, hashed with scrypt (never stored or logged in plain text), with failed-attempt lockout.
- **Instant remote sign-out**: Each staff account carries a `sessionVersion`; bumping it invalidates every existing session for that account across every device immediately, without needing a token blocklist.
- **Public-surface rate limiting**: The customer-facing order link enforces per-window submission limits to blunt abuse without requiring an account.
- **Role separation**: Staff vs. owner-level actions are checked server-side on every request, not just hidden in the UI.

---

## 7. Mobile Shipping Pipeline

The web app is wrapped for iOS and Android with Capacitor rather than rebuilt as a separate native codebase:

- Because the app depends on server actions and a live Postgres database, it's shipped as a Capacitor shell pointed at the **deployed URL**, not a static export — the native wrapper is a native chrome (icon, splash screen, status bar, Android hardware back button) around the same server-rendered app, not a bundled copy of it.
- A GitHub Actions workflow builds the Android APK/AAB on a standard Linux runner, and separately compiles (and, once signing credentials are added as secrets, archives) the iOS project on GitHub's hosted macOS runners — meaning the full native build pipeline exists and is testable without ever needing local Xcode or a physical Mac.
