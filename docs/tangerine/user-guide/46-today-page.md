# 46. Today Page (your daily starting point)

> **Status (2026-07):** Phases 1 + 2 + 3 shipped. The Today page is the first step of the **assistant-first** program (arch: `P28-assistant-first-architecture.md`): a per-user landing surface that shows what's waiting on you, what the system is doing, and what deserves attention — across **every module you have access to**, not just accounting. Phase 2 adds the AI assistant's spoken morning brief and "what do you want to work on?" routing.

**Where:** `/tangerine?m=today` — the **🌅 Today** section at the far left of the top nav.

The page has three sections, each computed live from the real queues (no AI involved in the numbers — if a count is on the Today page, it ties to the panel it links to):

## 46.1 Your assistant (morning brief + go-to router)

The greeting bar is where the assistant lives:

- **Morning brief** — on your first visit of the day the assistant reads your queues and writes a 2-4 sentence brief ("3 approvals are waiting on you, 12 SO lines ship this week, last night's mirror ran clean"). It can only cite items that are actually on the page — the numbers always tie. One model run per user per day; **↻** next to the brief re-reads and rephrases after you've worked the queue down.
  - **It tracks your progress through the day.** The brief is a live companion, not a static morning to-do dump. It stays aware of the whole page — your to-do list included — so it never keeps recommending something you've already handled. When you clear a to-do the assistant flagged (say you read all the vendor replies it pointed out), the page quietly rewrites the brief: it opens with a brief acknowledgment of what you finished ("You cleared the 4 vendor replies I flagged — nice."), covers only what's *still* waiting, and ends by inviting the next thing ("What do you want to work on next?"). It rewrites the same way when a *new* flag appears or a process card *flips state* (e.g. a Xoro mirror that was red this morning is now green). What does **not** trigger a rewrite is a count simply ticking up or down on an item that's still open — the live cards already show the current number, so the brief isn't churned for that. It still only names real items: anything it congratulates you on is something you actually cleared, and everything it lists is on the page.
- **"What do you want to work on?"** — this box is a **router, not a chat**. Type where you want to go — *"month close"*, *"pos flagged here"*, *"chargebacks"*, *"sales orders"* — and press **Go** (or Enter). The app takes you straight there: it matches your words against your **live to-dos** first (so *"pos flagged here"* opens the flagged-PO to-do, not just the generic Purchase Orders panel) and against the full module list, then navigates and shows a brief "Opening …" confirmation. If it isn't sure, it shows a row of **Did you mean:** chips to pick from instead of guessing; if nothing matches it nudges you to name one of your to-dos. For an actual **question** ("what's most urgent?", "how do I use this screen?"), use the floating **✨ Ask AI** button that's on every page — that's the chat surface.
- The router is scoped exactly like the page: it only routes to to-dos and panels in your access-filtered queue, minus anything you dismissed today.

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

**Every to-do drills straight to the items that need work.** Clicking a row no longer just opens the bare panel — it opens it **pre-filtered to exactly the subset the count refers to**, so you land on the work, not a screen to go hunt in. *Styles missing a size scale* opens Style Master showing **only** those styles (with 🎯 Auto-assign right there); *PPK styles without a matrix* opens Prepack Matrices focused on the needed list; *Chargebacks to disposition* lands on the open items; *Prior months not closed* opens Month-End Close already on the earliest unfinished month; *Failed QC inspections* filters to the failures; *Draft SOs older than 3 days* filters Sales Orders to drafts; *Cases assigned to you* / *unassigned open cases* filter the case list to yours / the unowned ones; *Unread notifications* opens with read items hidden; *Build orders open* filters to the WIP-carrying builds. When a click applies a filter, a small blue banner names it with a **✕ Clear** so you're never stuck in a filtered view. (A few status-page items — Sync Health, the mirror process cards, the Planning app and PO WIP — open as-is, since there's no sub-list to narrow.)

**Access-rights aware:** when RBAC enforcement is on, you only see rows for modules you hold read access to — a warehouse user's Today page and the bookkeeper's look completely different.

## 46.1b The assistant follows you (companion mode)

The assistant is not confined to the Today page:

- **It knows what you're looking at.** Every module you open is reported to the assistant, so on any panel you can ask *"what am I looking at?"*, *"what's wrong here?"*, or *"how do I use this screen?"* without explaining where you are. (It still fetches real numbers from the database - the screen context is orientation, not data.)
- **One thread per day.** Your conversation carries across panels all day - ask about an approval on the Today page, open Journal Entries, and keep talking. Overnight the thread resets so each morning starts fresh with the new brief.
- **Coach tips.** When you land on a panel where the assistant has a relevant suggestion (e.g. Style Master while thousands of styles are missing a size scale), a small tip chip appears near the ✨ Ask AI button. **Ask the assistant** opens the chat pre-filled; **✕** dismisses it for the day. A tip shows at most once per panel per session - the assistant is meant to help, not nag.

## 46.2 Active processes

Status cards for the machinery: the Xoro shadow-mirror runs (per domain) and the EDI outbox, with a green / blue / red dot and the last-run detail. Click a card to open its status panel.

## 46.3 Current state

Analysis-grade items: coded suggestions (e.g. *overdue PO lines usually mean a stale expected date — update from the vendor portal thread*) and the AI insights feed. Suggestions are dismissible for the day, same as to-dos.

## 46.4 Notes

- **Refresh** (↻, top right) re-computes everything on demand; the page also loads fresh on every visit.
- If one section's source has a hiccup, the rest of the page still renders — a footnote tells you counts may be partial.
- **Make it your landing page:** the **★ Make this my landing page** button (top right) sets Today as your personal auto-landing screen (the same home-route preference the ★ favorites system uses) - next sign-in opens here. Each user decides for themselves; nothing is forced.
