# 46. Today Page (your daily starting point)

> **Status (2026-07):** Phases 1 + 2 shipped. The Today page is the first step of the **assistant-first** program (arch: `P28-assistant-first-architecture.md`): a per-user landing surface that shows what's waiting on you, what the system is doing, and what deserves attention — across **every module you have access to**, not just accounting. Phase 2 adds the AI assistant's spoken morning brief and "what do you want to work on?" routing.

**Where:** `/tangerine?m=today` — the **🌅 Today** section at the far left of the top nav.

The page has three sections, each computed live from the real queues (no AI involved in the numbers — if a count is on the Today page, it ties to the panel it links to):

## 46.1 Your assistant (morning brief + chat)

The greeting bar is where the assistant lives:

- **Morning brief** — on your first visit of the day the assistant reads your queues and writes a 2-4 sentence brief ("3 approvals are waiting on you, 12 SO lines ship this week, last night's mirror ran clean"). It can only cite items that are actually on the page — the numbers always tie. One model run per user per day; **↻** next to the brief re-reads and rephrases after you've worked the queue down.
- **"What do you want to work on?"** — type into the ask box (e.g. *"let's do the approvals"*, *"what's most urgent?"*, *"open the chargebacks for Macy's"*). The Ask AI panel opens with your question; the assistant checks your live queue (`get_today`), answers, and when you pick something it **opens the panel for you** — the screen navigates to the module, optionally with the search box pre-seeded. Items that live in another app (PO WIP, Planning) can't be auto-opened; the assistant tells you where to go instead.
- The assistant is scoped exactly like the page: it sees your access-filtered queue, minus anything you dismissed today.

## 46.1 Your to-dos

One row per thing waiting on a person, sorted by urgency (**Action** → **Watch** → **FYI**), each with a live count. Click anywhere on the row to open the owning panel; click **✕** to mark it *done for today* — it disappears until tomorrow (the underlying queue is untouched).

What can appear here today:

| Item | Comes from | Opens |
|---|---|---|
| Approvals waiting on you | pending approval requests, minus your own submissions (you can never self-approve) | Approval Inbox |
| Vendor replies unread | vendor messages on POs no internal user has read | PO WIP |
| 3-way match exceptions | vendor invoices out of tolerance vs PO/receipt | 3-Way Match |
| PO lines due to receive this week / past expected | open PO lines (both PO systems) by expected date | Receiving |
| Failed QC inspections | QC failures with no disposition yet | QC Inspections |
| Chargebacks to disposition | open items on the chargeback worklist | Chargebacks |
| Prior months not closed / close not in use | the month-end close checklist state | Month-End Close |
| Nightly job errors (last 24h) | cron runs that logged errors | Sync Health |
| Draft SOs older than 3 days | sales orders entered but never confirmed | Sales Orders |
| SO lines due to ship this week / past requested ship | open demand lines by requested ship date | Allocations Workbench |
| Factored lines shipping soon without factor approval | the factor-credit gate will block these | Allocations Workbench |
| Buy-plan batches awaiting approval | draft execution batches in the Planning app | Planning |
| Styles missing a size scale / PPK styles without a matrix | master-data quality views (bulk Auto-assign / Prepack Matrices fix them) | Style Master / Prepack Matrices |
| Cases assigned to you / unassigned open cases | customer-service case queue | Cases |
| Unread notifications | your in-app notification inbox | Notifications |
| Build orders open | draft / issued / in-progress manufacturing builds | Build Orders |

**Access-rights aware:** when RBAC enforcement is on, you only see rows for modules you hold read access to — a warehouse user's Today page and the bookkeeper's look completely different.

## 46.2 Active processes

Status cards for the machinery: the Xoro shadow-mirror runs (per domain) and the EDI outbox, with a green / blue / red dot and the last-run detail. Click a card to open its status panel.

## 46.3 Current state

Analysis-grade items: coded suggestions (e.g. *overdue PO lines usually mean a stale expected date — update from the vendor portal thread*) and the AI insights feed. Suggestions are dismissible for the day, same as to-dos.

## 46.4 Notes

- **Refresh** (↻, top right) re-computes everything on demand; the page also loads fresh on every visit.
- If one section's source has a hiccup, the rest of the page still renders — a footnote tells you counts may be partial.
- **Make it your landing page:** the **★ Make this my landing page** button (top right) sets Today as your personal auto-landing screen (the same home-route preference the ★ favorites system uses) - next sign-in opens here. Each user decides for themselves; nothing is forced.
