# 46. Today Page (your daily starting point)

> **Status (2026-07):** Phase 1 shipped (P28-1-2). The Today page is the first step of the **assistant-first** program (arch: `P28-assistant-first-architecture.md`): a per-user landing surface that shows what's waiting on you, what the system is doing, and what deserves attention — across **every module you have access to**, not just accounting. Phase 2 adds the AI assistant's spoken morning brief and "what do you want to work on?" routing.

**Where:** `/tangerine?m=today` — the **🌅 Today** section at the far left of the top nav.

The page has three sections, each computed live from the real queues (no AI involved in the numbers — if a count is on the Today page, it ties to the panel it links to):

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

**Access-rights aware:** when RBAC enforcement is on, you only see rows for modules you hold read access to — a warehouse user's Today page and the bookkeeper's look completely different.

## 46.2 Active processes

Status cards for the machinery: the Xoro shadow-mirror runs (per domain) and the EDI outbox, with a green / blue / red dot and the last-run detail. Click a card to open its status panel.

## 46.3 Current state

Analysis-grade items: coded suggestions (e.g. *overdue PO lines usually mean a stale expected date — update from the vendor portal thread*) and the AI insights feed. Suggestions are dismissible for the day, same as to-dos.

## 46.4 Notes

- **Refresh** (↻, top right) re-computes everything on demand; the page also loads fresh on every visit.
- If one section's source has a hiccup, the rest of the page still renders — a footnote tells you counts may be partial.
- The Today page is **opt-in** for now (a nav item, not the forced landing screen). Once it proves itself it becomes the default post-login view.
