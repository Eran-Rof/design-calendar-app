# Notifications (M28)

**Shipped in P2 Chunks 3 + 4** (2026-05-27).

Notifications fan out events to recipients on two channels: **in-app** (a notification center inside `/tangerine`) and **email** (delivered via a Vercel cron worker).

## Where it lives

`/tangerine` top nav → **🔔 Notifications** + **🎚️ Notif. Preferences**.

| Panel | Who uses it | What it does |
|---|---|---|
| **Notifications** | Anyone | Inbox of in-app dispatches; click to mark as read. |
| **Notif. Preferences** | Anyone | Per-(kind, channel) opt-in / opt-out matrix. |

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
