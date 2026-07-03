# Notifications (M28)

**Shipped in P2 Chunks 3 + 4** (2026-05-27).

Notifications fan out events to recipients on two channels: **in-app** (a notification center inside `/tangerine`) and **email** (delivered via a Vercel cron worker).

## Where it lives

`/tangerine` top nav → **🔔 Notifications** + **🎚️ Notif. Preferences**.

| Panel | Who uses it | What it does |
|---|---|---|
| **Notifications** | Anyone | Inbox of in-app dispatches; click a row to **mark it read AND jump to the actual record it refers to** (the SO, PO, invoice, customer, …). |
| **Notif. Preferences** | Anyone | Per-(kind, channel) opt-in / opt-out matrix. |

## Click a notification → open its task (deep-link)

Every notification is clickable and navigates to the specific task or record it
is about — never a dead/inert item:

- A **Sales Order confirmation / production order** → opens that SO (Sales Orders filtered to its number).
- A **PO revision / message** → opens that purchase order.
- An **AR / AP invoice** event → opens AR/AP Invoices filtered to the invoice number.
- A **customer / vendor** nudge → opens that party's master record (and the specific contact/note when present).
- **GL period, inventory adjustment, cycle count, CRM task, RFQ** events → open the owning module.

How it resolves (single shared resolver, so every type routes through one place):

1. If the notification already carries a specific link/reference, use it.
2. Otherwise the resolver derives a deep link from the notification's stored
   reference (order number, invoice number, record id, …) plus its event type.
3. If an exact record can't be addressed, it **falls back gracefully** to opening
   the relevant module/list rather than going nowhere.

Records are always addressed by a human reference (order/invoice number) for the
filter — no raw UUIDs are shown. The same resolver powers the **vendor portal
bell** (opens the PO / RFQ / invoice / dispute / contract), the **cross-app
notifications page** (PO WIP, Design Calendar, GS1, Tech Packs), and the
**Tangerine Notification Center**.

## Architecture (short version)

```mermaid
flowchart LR
  A[Caller<br/>posting service / handler] --> B["notificationsAPI.enqueue({...})"]
  B --> C[notification_events row<br/>(immutable)]
  C --> D[Fan-out:<br/>1 dispatch per recipient × channel]
  D --> E1[in_app: status=sent<br/>shows in inbox immediately]
  D --> E2[email: status=pending<br/>queued for cron]
  E2 --> F[notifications-email-drain<br/>(*/2 * * * *)]
  F --> G[Resend HTTP API]
  G --> H[email delivered<br/>status=sent]
```

## Channels at launch

- **In-app** — sent synchronously when `enqueue` records the event. The Notification Center pulls them with the `?channel=in_app` filter.
- **Email** — `pending` status until the cron drains them. Configured via `RESEND_API_KEY` + `RESEND_FROM_EMAIL` env vars.

`push`, `sms`, and `digest` are deferred (post-P2).

## Preferences

The default is **opt-in for every (kind, channel) pair**. A row in `notification_preferences` is only created when the user explicitly opts OUT — that suppresses future fan-out for that pair. Opt back in by clicking again.

### Email sender setup

The cron worker prefers Resend over SMTP per arch §12.1. Configure:

```
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=notifications@ringoffireclothing.com
```

Without `RESEND_API_KEY`, the cron falls back to a mock that records dispatches as `sent` without actually emailing — useful for dev/staging.

## What's dormant vs live

- ✅ **Live:** schema, library, both admin panels, email cron registered.
- ⚠️ **Dormant:** no downstream caller invokes `notificationsAPI.enqueue` yet. The first integrations (JE posted, period closed, approval requested) land alongside their owner modules. Until that happens, the inbox stays empty.

## Related architecture

- [`../P2-cross-cutters-architecture.md` §5](../P2-cross-cutters-architecture.md) — full M28 spec
- See [Approvals (M27)](07-approvals.md) for the sibling cross-cutter that *will* call enqueue when approval requests are created (planned drop-in: P2 follow-up).
