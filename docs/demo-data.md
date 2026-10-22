# Example Data Shapes

Illustrative only — every name, number, and order below is fabricated for this document. Nothing here is the real business's data, and nothing in this showcase connects to the live app or its database.

---

## AI-parsed WhatsApp order

A customer message, and the structured draft it produces before anything is saved:

**Input** (WhatsApp DM):
```
hi abeg 2 jollof n chicken, one zobo, deliver to 14 Freedom Way Lekki by 6
```

**Parsed output** (`ParsedOrder`, before menu-matching):
```json
{
  "parser": "ai",
  "isOrder": true,
  "customerName": null,
  "deliveryAddress": "14 Freedom Way, Lekki",
  "dueAt": "2026-10-22T18:00:00.000+01:00",
  "items": [
    { "text": "2 jollof n chicken", "quantity": 2, "menuItemName": "Jollof rice & chicken", "confidence": 0.95 },
    { "text": "one zobo", "quantity": 1, "menuItemName": "Zobo (50cl)", "confidence": 1 }
  ],
  "confidence": 0.9,
  "questions": []
}
```

Every `menuItemName`/price comes from a database lookup via the fuzzy matcher, never from the model's text — see [`snippets/menu-match.ts`](../snippets/menu-match.ts).

---

## Chowdeck sync result

What a sync run returns (and what the Settings page shows the owner):

```json
{
  "fetched": 14,
  "created": 3,
  "statusUpdated": 2,
  "unchanged": 9,
  "errors": []
}
```

An order the sync creates, before anyone edits it — one line at the order total, flagged for review since Chowdeck's API doesn't expose item-level detail:

```json
{
  "channel": "CHOWDECK",
  "status": "PREPARING",
  "externalRef": "chowdeck:48213",
  "totalKobo": 460000,
  "needsReview": true,
  "reviewNote": "Synced from Chowdeck — item breakdown isn't available via the API, so this is one line for the order total.",
  "items": [
    { "name": "Chowdeck order (see Chowdeck dashboard for items)", "quantity": 1, "unitPriceKobo": 460000 }
  ]
}
```

---

## Daily profit snapshot

The shape behind the Profit dashboard's channel breakdown (fabricated figures):

```json
{
  "revenueKobo": 18250000,
  "foodCostKobo": 6120000,
  "byChannel": [
    { "channel": "STAND", "orders": 41, "revenueKobo": 9870000 },
    { "channel": "WHATSAPP", "orders": 18, "revenueKobo": 4200000 },
    { "channel": "CHOWDECK", "orders": 9, "revenueKobo": 2650000 },
    { "channel": "ONLINE", "orders": 6, "revenueKobo": 1530000 }
  ]
}
```
