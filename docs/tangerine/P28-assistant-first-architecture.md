# P28 — Assistant-First Suite Architecture

**Status:** DRAFT — awaiting CEO approval of Phase 1 chunk plan (§10) before implementation.
**Author:** Claude, 2026-07-14, from CEO vision statement (same date).
**Scope:** the whole suite — every module a user can touch, NOT just accounting.

---

## 1. Vision (CEO, 2026-07-14)

> A welcome page set by each user's access rights. The assistant greets the user as *his*
> assistant, gives the state of a to-do list for the day, the state of active processes, and
> analysis of the current state, then asks which of these he wants to work on. The user answers
> and the assistant automatically opens the UI. In the UI the assistant continues to help with
> any automated functions — commenting with suggestions on what to do next or how to do it
> faster/better. A real partner, there with the user throughout his daily work, making daily
> tasks more accurate and faster.

Explicit constraint from the CEO: **this must work for POs, SOs, allocations, and all other
modules** — accounting is one module among many, not the center.

## 2. Principles

1. **Deterministic core, AI voice on top.** Everything the Today page *shows* (to-dos, process
   state, exceptions) is computed by plain code from live tables. The AI phrases, prioritizes,
   converses, and routes — it never invents the facts. If the AI is down, the page still works.
2. **Module-universal by construction.** No module-specific code in the page or the assistant
   loop. Every module contributes through one registry contract (§4, "capability packs"). Adding
   a module to the assistant = adding one pack file. Accounting, PO, SO, allocations, planning,
   ATS, style master, manufacturing, chargebacks, EDI, 3PL — same contract.
3. **RBAC is the lens.** Every section is filtered through P14 `v_effective_permissions`
   (module_key:action). A user with no PO grant never sees PO to-dos; a warehouse user's page
   looks nothing like the bookkeeper's. No new permission system — the packs declare which
   module_key each item belongs to and the aggregator filters.
4. **Assist, never self-post.** Read + navigate + draft freely; any write executes only after an
   explicit user confirm, and money-moving writes route through the existing M27 maker-checker
   flow (#1743) with T11 reasons. The assistant is a maker, never a checker.
5. **Coach, not just clerk.** The assistant knows the user guide (bundled snapshot, ch01–45) and
   the operator's own facts (`ip_ai_user_facts`), so it can say "there's a bulk auto-assign for
   that" instead of watching a user do 200 single edits. Suggestion rules are code (like
   `proactive-rules.js`), with the AI phrasing them.

## 3. What already exists (reuse inventory — verified 2026-07-14)

| Piece | Where | Reused for |
|---|---|---|
| Per-user permission set | `api/_lib/rbac/index.js` → `v_effective_permissions` | RBAC lens on every section |
| Ask AI panel + streaming loop | `src/ai/AskAIPanel.tsx`, `api/_handlers/ai/ask-grid.js` | the conversational surface (Tangerine on Opus 4.8) |
| Read-only DB tools + workflows | `api/_lib/ai/tool-defs.js`, `workflows.js` | assistant answers + automated functions |
| Rule-based insights + crons | `api/_lib/ai/proactive-rules.js`, `api/_lib/insights.js`, `ip_ai_insights`, `cron/insights-digest-daily.js` | "analysis of current state" feed |
| Approvals / notifications / cases queues | M27 / M28 / M47 tables | to-do sources |
| Process telemetry | `xoro_mirror_runs`, cron heartbeats, `app_errors`, EDI outbox/inbox (#1742) | "active processes" section |
| Identity | MS-OAuth bridge + `getCachedAuthUserId` | greeting by name, per-user state |
| Drill params | `consumeDrillParams()` pattern (consumed once on mount) | click-through + `open_panel` routing |
| User guide search | `search_user_guide` + `userGuideContent.js` (current thru ch45) | coaching answers |

**Genuinely new:** the Today page itself, the capability-pack registry, the `open_panel` action,
per-user morning briefs, panel-context feed to the assistant, suggestion ("coach") rules.

## 4. The capability-pack registry (the load-bearing design)

One file per module at `api/_lib/assistant/packs/<module>.js`, registered in
`api/_lib/assistant/registry.js`. A pack exports a plain object:

```js
export default {
  key: "po",                    // stable pack id
  module_keys: ["procurement"], // P14 module_key(s) that gate this pack's output
  label: "Purchase Orders",

  // (a) To-do providers — "what is waiting on THIS user today"
  //     async (db, ctx) => [{ id, title, count, severity, panel, drill, due?, kind }]
  todos: [openVendorPortalReplies, posStaleVsXoro, receiptsDueThisWeek, drafts3WayExceptions],

  // (b) Process providers — "what is the system doing in my area"
  //     async (db, ctx) => [{ id, label, state: ok|running|warn|error, detail, last_run_at, panel? }]
  processes: [ediOutboxState, poSyncHealth],

  // (c) Suggestion rules — "what should you do next / faster" (pure code, AI phrases later)
  //     (aggregates) => [{ id, dedupe_key, text, panel?, drill?, guide_ref? }]
  suggestions: [suggestPortalSendForTbdPickers, suggestBulkScaleAssign],

  // (d) Actions — automated functions the assistant may run for the user
  //     { name, description, input_schema, mode: "read"|"draft"|"write_confirm", run(db, input, ctx) }
  actions: [draftPoRevision, draftVendorChaseEmail],

  // (e) Panels — routable destinations for open_panel (validated against menuKeys)
  panels: { po_grid: {...}, receiving: {...}, three_way_match: {...} },
};
```

`ctx` = `{ userId, entityId, permissions:Set, today }`. The aggregator
(`api/_lib/assistant/today.js`) runs every pack whose `module_keys` intersect the caller's
permissions, in parallel with per-pack try/catch isolation (one broken pack never blanks the
page — same isolation discipline as the FBA mirror's per-account loop).

**Why a registry and not per-module endpoints:** one RBAC filter, one caching layer, one
handler, one UI contract; packs stay unit-testable pure functions over injected data; and the
assistant's tool surface (`get_today`, `open_panel`, `run_action`) stays constant while packs
grow underneath it.

### 4.1 v1 launch packs (Phase 1) — deliberately spanning the suite

| Pack | Example to-dos | Example processes | Example suggestions |
|---|---|---|---|
| **po** (procurement, BOTH PO models per the two-model rule) | vendor portal replies unread; POs stale vs Xoro; receipts due ≤7d; 3-way exceptions; QC failures awaiting disposition | EDI outbox (#1742), PO sync health | "3 POs have TBD pickers — send to portal"; "5 draft POs from the buy plan await issue" |
| **so_allocations** | draft SOs aging >3d; confirmed SO lines unallocated **with ATS available**; factor-credit holds; upload-PO parses awaiting review | allocation runs | "Run Auto-allocate: 4 SOs can full-fill today"; "SO 1234 can ship complete if you split the backorder color" |
| **planning_ats** | buy recs awaiting batch approval; back-order-window matches; low-ATS on active styles | nightly forecast build state | "12 styles hit reorder point this week — open Supply view" |
| **master_data** | styles missing size scale / prepack matrix / images / HTS; customer dupes | — | "34 new styles can be scale-assigned in one click (Auto-assign)" — the #934/#939 confusion is exactly what this prevents |
| **accounting** | approvals awaiting me (maker-checker); unapplied receipts; chargeback residuals unworked; close checklist gaps | mirror runs, tie-out cron, bank recon cron | "Period close pre-flight has 2 blockers — start with the stale customs entry" |
| **manufacturing** | builds awaiting parts; CMT receipts pending 3-way | — | — |
| **cases_inbox** | my open cases; unread notifications | — | — |

(Deferred packs: shopify, b2b_portal, edi_customers, 3pl — add after v1 proves the contract.)

## 5. Phase 1 — the Today page (deterministic)

**Route:** `/tangerine?m=today` — registered in both menuKeys registries (dual-registry rule).
**Default landing:** after login, users land on Today; a header link returns anytime. (Open
decision D2: replace home vs opt-in first — recommend **opt-in for one week, then default**.)

**Layout** (dark palette per app standard, responsive, no decorative emoji):
1. **Greeting bar** — "Good morning, Eran" (employee display name), date, entity. Phase 1 text
   is templated; Phase 2 replaces it with the assistant's phrased brief + chat input.
2. **Your to-dos** — pack to-dos merged, severity-sorted, grouped by pack label. Full-row click
   drills to the panel with prefilled filters (blue identifier, no ↗, per UI non-negotiables).
   Per-item dismiss ("done for today") persisted.
3. **Active processes** — pack processes as status cards (ok/running/warn/error) + last-run
   time; errors link to the owning panel.
4. **Current state** — the existing `ip_ai_insights` feed (already deduped + severity-scored),
   RBAC-filtered by the insight's pack/module tag; suggestion-rule output lands here too.

**API:** one handler `GET /api/internal/assistant/today` (route APPENDED via gen:routes; RBAC
route permission = authenticated; content self-filters by caller's permission set). Response is
the merged `{greeting_ctx, todos[], processes[], insights[], suggestions[]}`. 60s client cache;
sections render independently (skeleton per section, one slow pack can't block the rest).

**Schema (minimal, one migration):**
- `assistant_dismissals` (user_id, item_dedupe_key, dismissed_on date) — to-do/suggestion
  dismiss state, keyed the same way proactive-rules dedupes.
- `ip_ai_insights.pack_key text NULL` — lets the state section RBAC-filter existing insights.
- Nothing else — to-dos and processes are computed live from source tables.

## 6. Phase 2 — the assistant takes the stage

- **Morning brief:** per-user, generated on first Today load of the day (cached in
  `assistant_briefs` (user_id, brief_date, body, source_json)) by running the Phase-1 aggregate
  through the Tangerine model. The brief cites only aggregate items (deterministic facts).
- **"What do you want to work on?"** — chat input on the Today page, backed by the existing
  ask-grid loop with three new tools:
  - `get_today` (read: returns the user's current aggregate — the brief's source of truth),
  - `open_panel` (terminal: `{panel_key, drill}` validated against the registry's `panels`
    union; client navigates via the existing drill-params mechanism),
  - `run_action` (looped: executes a pack action; `mode:"read"` runs freely, `"draft"`/
    `"write_confirm"` return a preview the client renders with an explicit Confirm button —
    confirm re-invokes with a signed confirmation token).
- **Per-app limits:** raise Tangerine to MAX_TOKENS 2048 / 14 iterations (per-app override
  alongside `MODEL_BY_APP`); evaluate Claude 5 family vs Opus 4.8 on the golden-questions suite
  before switching (D4).

## 7. Phase 3 — companion through the day

- **Panel context feed:** panels publish `{panel_key, record_ids?, filters?}` through
  `askAIBridge` (the bridge already exists for grid mutations — this adds the reverse
  direction). The assistant's system prompt gets a "you are looking at…" block, so "why is this
  one unbalanced?" or "which of these POs is late?" needs no restating.
- **Day thread:** one conversation thread per user per day (extend `conversationStore`),
  carried from the Today page into every panel.
- **Coach mode:** suggestion rules gain panel-scoped triggers (fired by context feed, not cron)
  — e.g. user is on Style Master with a scale filter → surface bulk auto-assign; user is
  hand-allocating an SO → surface Auto-allocate with fill modes. Each tip links its user-guide
  chapter. Frequency-capped + dismissible (a nagging assistant is worse than none).

## 8. Phase 4 — doing, not just showing

Pack actions graduate to `write_confirm` in earnest: draft JEs/reclasses, chargeback match
suggestions (the residual of #1744's 86.4%), draft PO revisions, draft vendor/customer emails
(CEO-copyable per the not-admin rule), case creation, SO allocation apply. All money-moving
writes go through `requestIfRequired` (maker-checker) exactly like the human path — the
assistant produces the same 202-held state a human maker gets, and can never approve (T11
reason required; `created_by` = the human user, so self-approval rules keep working).
Own architecture pass before build (P28-4).

## 9. Non-goals (this pass)

- No autonomous writes, ever — no cron that posts, allocates, or emails without a human confirm.
- No new permission system, no new notification channel, no mobile app.
- No replacement of the floating Ask AI panel — the Today page and the panel share one brain.
- No AI-generated to-dos: to-dos come from queues and rules only (AI phrases, never invents).

## 10. Phase 1 chunk plan (implementation gate — needs approval)

| Chunk | Scope | Est |
|---|---|---|
| P28-1-1 | Registry + aggregator + `assistant_dismissals` migration + **po** and **accounting** packs (proves the contract on both a document-flow module and a ledger module) + unit tests on pure providers | 1 PR |
| P28-1-2 | Today page UI (`m=today`, 4 sections, drill-through, dismiss) + handler + menuKeys + guide chapter | 1 PR |
| P28-1-3 | **so_allocations** + **planning_ats** + **master_data** packs | 1 PR |
| P28-1-4 | **manufacturing** + **cases_inbox** packs + processes card polish + default-landing toggle | 1 PR |

Each chunk: isolated branch, #N-prefixed PR, squash auto-merge on CI green, user-guide update
in the same PR, BUILD-PROGRESS bump.

## 11. Open decisions for the CEO

- **D1 — v1 pack order:** §4.1 proposes po + accounting first (P28-1-1). Reorder freely.
- **D2 — landing behavior:** opt-in home tab for a week, then default landing (recommended), or
  default immediately.
- **D3 — to-do definition of "mine":** v1 = items assigned/awaiting the user + entity-wide items
  in modules they hold `write` on. Tighten later per role feedback.
- **D4 — model:** stay Opus 4.8 vs move Tangerine to a Claude 5 model — decide on golden-suite
  results, not vibes.

## 12. Risks

1. **Registry contract churn** — mitigated by shipping two very different packs first (P28-1-1).
2. **Slow packs blank the page** — per-pack try/catch + per-section skeletons + 60s cache.
3. **Suggestion fatigue** — dedupe keys + daily frequency caps + dismiss persistence from day 1.
4. **PostgREST 1000-row cap** on queue counts — providers must aggregate server-side (count
   queries / RPCs), never fetch-then-count.
5. **Two PO models** — the po pack MUST union `tanda_pos` and native `purchase_orders` like the
   vendor portal does, or half the to-dos are invisible.
