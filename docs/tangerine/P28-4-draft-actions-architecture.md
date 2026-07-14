# P28-4 — Draft Actions Architecture (doing, not just showing)

**Status:** DRAFT — architecture only, no code. Awaiting CEO approval of the chunk plan (§9)
and the open decisions (§10) before implementation.
**Author:** Claude, 2026-07-14.
**Parent:** `docs/tangerine/P28-assistant-first-architecture.md` — this doc is the promised
"Own architecture pass before build (P28-4)" for §8 ("Phase 4 — doing, not just showing").

---

## 1. Scope

Phases 1–3 made the assistant **read, brief, navigate, and coach**. Phase 4 lets it **draft an
action the operator confirms**. The load-bearing claim of this doc: Phase 4 is almost entirely
*wiring the assistant into machinery that already exists* — the M27 maker-checker engine, the GL
posting service, the T11 reason gate, the P14 RBAC lens, the chargeback matcher — behind one new
tool and one confirmation handshake. **No new financial machinery is built.**

Every write in Phase 4 is:
1. **Never executed by the model.** The model can only produce a *preview*; a separate,
   authenticated confirm step performs the write.
2. **Confirm-gated** — an explicit operator Confirm click, verified against a signed token.
3. **RBAC-gated** — the confirming operator must hold `write`/`post` on the target module.
4. **Maker-checker-gated when money moves** — routed through `requestIfRequired` exactly like the
   human path, producing the same HTTP-202 held state.
5. **T11-reasoned** — any path that leads to a GL post carries an `audit_reason`.

## 2. Principles (inherited + Phase-4 specific)

Inherits P28 §2 wholesale ("Assist, never self-post"; "RBAC is the lens"). Phase-4 additions:

- **The model proposes; a human disposes; a *second* human approves money.** The assistant is a
  drafting aid, not an actor. It holds no identity in `entity_users`, so it can never be
  `actor_user_id` in `decide()` — it is structurally incapable of approving anything.
- **Two boundaries, not one.** The model↔server boundary produces a *preview* (safe, read-only).
  The client↔server *confirm* boundary produces the *write* (authenticated, RBAC-checked). They are
  different endpoints with different trust levels (§5, §6).
- **Preview must equal commit.** What the operator confirms must be byte-for-byte what executes —
  enforced by a signed canonical hash, not by re-sending the payload and trusting it (§6).

## 3. Reuse inventory (verified 2026-07-14 — every row read this session)

| Piece | Where (verified) | Reused for |
|---|---|---|
| Capability-pack registry + `validatePack` | `api/_lib/assistant/registry.js` | Phase 4 **extends** `validatePack` to also validate an `actions[]` array (today it validates only todos/processes/suggestions/panels — see §11 divergence) |
| Pack objects | `api/_lib/assistant/packs/*.js` (e.g. `accounting.js`) | gain an `actions:` key; no pack declares one yet |
| Ask-grid tool loop (streaming + non-streaming) | `api/_handlers/ai/ask-grid.js`, `api/_lib/ai/streaming.js` | hosts the new `run_action` tool; already threads `execCtx` (`user_id`, `app`) into every executor as the 3rd arg |
| Executor dispatch map | `api/_lib/ai/executors.js` → `TOOL_EXECUTORS`; today-executor pattern in `executors-today.js` | `run_action` executor registers here identically to `get_today` |
| Terminal-tool handling | `api/_lib/ai/constants.js` → `TERMINAL_TOOLS`; loop extracts `actions[]` in `streaming.js` L163-186 and `ask-grid.js` L315-338 | the Confirm card is delivered via the existing `actions[]` channel (same plumbing as `open_panel`) |
| Client action applier | `src/ai/AskAIPanel.tsx` L614-647 (`navActions`/`onOpenPanel` split, L622-634) | renders a new **Confirm card** action type; on click calls the confirm endpoint |
| Maker-checker engine | `api/_lib/approvals/index.js` → `requestIfRequired()`, `decide()`, `cancel()` | money-moving drafts route here unchanged |
| Self-approval control | `decide()` L171-180 — refuses `approve` when `created_by_user_id === actor_user_id` (`self_approval_forbidden` → 403 via `decide.js` L248) | keeps working: `created_by` = confirming operator, so *they* can't approve their own draft; the assistant has no actor identity at all |
| Human JE post path | `api/_handlers/internal/journal-entries/index.js` — `requestIfRequired({kind:"je_manual_post", created_by_user_id: makerAuthId})` L164-192, 202-held response L193-201 | draft-JE action calls the SAME handler; nothing new |
| Decide → post hook | `api/_handlers/internal/approval-requests/decide.js` L80-103 (posts the snapshotted JE on approve, attributed to `payload.created_by_user_id`, not the approver) | draft-JE inherits the existing post-on-approve behavior |
| Human AP payment path | `api/_handlers/internal/ap-invoices/pay.js` — `requestIfRequired({kind:"ap_payment"})` L106-143 | AP-payment drafts (a later chunk) reuse it |
| T11 reason gate | `api/_lib/audit/withAuditContext.js` → `requireReason(op, reason)` L302-313 (blocks POST/VOID/REVERSE without a reason); `setAuditSessionVars` L221-231 | every draft that posts carries a reason in its payload |
| RBAC effective-permission set | `api/_lib/rbac/index.js` → `loadEffectivePermissions()` L54-67, `isAllowed()` L70-72; module map `routePermissions.js` `MODULE_ACTIONS` L23-32 | the confirm endpoint checks `<module_key>:write`/`:post` for the action's target module |
| Chargeback matcher (pure) | `api/_lib/chargebackMatch.js` → `matchChargeback()` L69-85, `buildInvoiceIndex()` L47-60 (exact/suffix, ambiguous→null) | the chargeback-match action's `preview()` calls this to propose the single unambiguous candidate |
| HMAC token primitive | `api/_lib/auth/appJwt.js` — `createHmac("sha256", secret)` + `timingSafeEqual` + base64url (L75-77, L95-98) | **exact pattern reused** to sign/verify the confirmation token (§6); do NOT hand-roll new crypto |
| Caller authentication | `api/_lib/auth.js` `authenticateCaller`; `appJwt.verifyAppJwt` | the confirm endpoint authenticates a real identity instead of trusting `body.user_id` (§5.3, §12 risk) |

**Genuinely new in Phase 4:** the `actions[]` pack sub-contract (`preview`/`commit`), the
`run_action` tool + its executor, the signed confirmation token + its verify, the confirm endpoint,
and the Confirm-card UI in AskAIPanel. Everything financial is reuse.

## 4. The pack `actions` contract (graduating parent §4)

Parent §4 already sketches the shape:
`{ name, description, input_schema, mode: "read"|"draft"|"write_confirm", run(db, input, ctx) }`.
Phase 4 makes it real with **one safety refinement**: split `run` into two functions so the
model-reachable path is *physically incapable* of writing.

```js
// api/_lib/assistant/packs/<module>.js  — a pack action
{
  name: "draft_chargeback_match",         // globally-unique, snake_case; doubles as the run_action arg
  label: "Suggest a chargeback match",
  module_key: "finance_misc",             // P14 gate (same vocabulary as todo providers)
  mode: "write_confirm",                  // "read" | "draft" | "write_confirm"
  required_action: "write",               // "write" | "post" — checked against module_key at confirm
  input_schema: { /* JSON Schema, same style as tool-defs.js */ },

  // MODEL-REACHABLE. Read-only. Returns a human-readable preview + the exact
  // canonical payload commit() will consume. MUST NOT write. Runs under the
  // same per-pack try/catch discipline as today's providers.
  async preview(db, input, ctx) {
    return {
      summary: "Link chargeback CB-1234 ($412.00) to invoice ROF-I141259 (exact match).",
      // canonical, minimized payload — this is what gets hashed + signed
      commit_payload: { chargeback_id, invoice_id, method: "invoice_number_exact" },
      warnings: [],                        // e.g. "no unambiguous match found" → block
    };
  },

  // NEVER model-reachable. Only the authenticated confirm endpoint calls this,
  // and only after the token verifies and RBAC passes. For money-moving actions
  // commit() calls requestIfRequired() and returns the 202-held result.
  async commit(db, commit_payload, ctx) { /* ... */ },
}
```

`ctx` for actions = the same lens object the aggregator builds
(`{ userId, entityId, permissions, todayISO }`, per `context.js` `buildTodayForUser`) — extended
with nothing new for `preview`; `commit`'s `ctx.userId` is the **verified** confirming operator.

**Registry changes (P28-4-1):** extend `validatePack()` to validate each `actions[]` entry
(`name`, `module_key`, `mode ∈ {read,draft,write_confirm}`, `preview` is a function, and for
non-read modes `commit` is a function + `required_action ∈ {write,post}`); add `allActionNames()`
(globally unique, mirrors `allProviderKeys()`); add an `actionByName(name)` lookup. Pure, unit-
testable — same test discipline as the existing registry validators.

## 5. `run_action` tool + the confirm handshake

### 5.1 Tool surface (added to `tool-defs.js`)

```
run_action { action: <enum of allActionNames()>, input: <object> }
```

Like `open_panel`'s enum being generated from `panelKeys()`, `run_action`'s `action` enum is
generated from `registry.allActionNames()` so a new pack action auto-widens the schema.
`TOOL_LABELS` gets a "Preparing that action…" entry.

### 5.2 Loop behavior — `run_action` is **looped**, never a direct writer

The executor (`tool_run_action`, registered in `TOOL_EXECUTORS` beside `get_today`):

1. Resolves the action via `actionByName`; unknown → `{error}` (model recovers, per loop contract).
2. **RBAC pre-check (advisory):** if `permissions` are resolvable for `execCtx.user_id`, verify
   `isAllowed(permissions, action.module_key, action.required_action)`; if not, return
   `{ error: "not_permitted" }` so the model tells the operator instead of drafting a dead action.
   (Authoritative RBAC is re-checked at commit — §5.3 — because ask-grid does not verify a JWT.)
3. `mode: "read"` → runs `preview()` (read-only) and returns its data; the model summarizes. Done.
4. `mode: "draft" | "write_confirm"` → runs `preview()`, then mints a **confirmation token** (§6)
   over `{ action, hash(commit_payload), user_id, entity_id, exp }`, and returns to the model:
   `{ status: "needs_confirmation", summary, warnings }` **plus the token echoed in the tool
   result** so the model can hand it to the terminal step. The model then emits a terminal
   **`present_confirmation`** tool (added to `TERMINAL_TOOLS`) with
   `{ summary, token, action }`. The loop's existing terminal-extraction (`streaming.js` L179-181 /
   `ask-grid.js` L331-333) already funnels unknown terminal tools into `actions[]` — so the Confirm
   card rides the **same channel** as `open_panel` with zero loop rewrite.

> Why a second (terminal) tool instead of making `run_action` itself terminal: `TERMINAL_TOOLS` is
> a static name Set consulted *before* the executor runs, so a single tool cannot be
> "terminal only in write mode" without loop surgery. Splitting preview (looped) from the
> Confirm-card emission (terminal) keeps both existing loops untouched. See §11 for the alternative.

### 5.3 Confirm endpoint — the write boundary (`POST /api/internal/assistant/actions/confirm`)

New handler, route APPENDED via `gen:routes`. This is where the write actually happens:

1. **Authenticate a real identity** — `authenticateCaller(req, admin)` / `verifyAppJwt`, or the
   SPA-injected `X-Auth-User-Id` header (the reliable maker id in this deployment, exactly as the
   JE handler uses it: `journal-entries/index.js` L148-149). It does **not** trust `body.user_id`.
2. **Verify the token** (§6): signature (timing-safe), not expired, and `token.user_id` ===
   authenticated caller. Reject replay (§6.3).
3. **Re-run RBAC authoritatively** — `loadEffectivePermissions(admin, authId, entityId)` then
   `isAllowed(perms, action.module_key, action.required_action)`; 403 on miss.
4. **Verify preview == commit** — re-hydrate `commit_payload` from the request, hash it, and require
   it equals `token.payload_hash`. Any drift → 409 (the previewed action is not what's being
   confirmed).
5. Call `action.commit(admin, commit_payload, { userId: authId, entityId, ... })`.

For money-moving actions, `commit()` is a thin wrapper that calls the **existing** handler path
(e.g. builds the manual-JE body and calls `requestIfRequired`/`postManualJournalEntry` semantics)
with `created_by_user_id = authId` and a T11 `reason`. The response relays the underlying result —
including the **HTTP 202 held state** verbatim when a rule matches.

## 6. The confirmation token (tamper-proof, replay-safe, minimal)

Reuse the `appJwt.js` HMAC-SHA256 primitive — same `createHmac("sha256", secret)` +
`timingSafeEqual` + base64url building blocks (`appJwt.js` L75-77, L95-98). Do **not** add a crypto
dependency or invent a scheme.

### 6.1 Shape

A compact signed envelope (its own `iss: "tangerine-assistant-confirm"` so it can never be confused
with a session JWT):

```
payload = {
  act:  "draft_chargeback_match",        // action name
  ph:   sha256(canonicalJSON(commit_payload)),   // binds the EXACT write
  sub:  "<auth_user_id>",                // who previewed = who must confirm
  ent:  "<entity_id>",
  jti:  "<random>",                      // replay id
  iat, exp                               // short TTL, e.g. 5 min
}
token = base64url(header).base64url(payload).HMAC
```

Secret: reuse `TANGERINE_JWT_SECRET` (already loaded by `appJwt.secret()`), or a dedicated
`TANGERINE_ACTION_CONFIRM_SECRET`. Gate exactly like appJwt: **no secret → the write actions are
simply unavailable** (preview still works; confirm 503s) — fail-closed, zero behavior change until
the env var is set.

### 6.2 Why this is sound

- **Tamper-proof:** `ph` binds the canonical hash of the write. Change a dollar amount, an account,
  or an invoice id between preview and confirm → hash mismatch → 409. The client cannot forge a
  token (no secret).
- **Identity-bound:** `sub` must equal the *authenticated* confirmer (§5.3 step 1-2), not a
  client-supplied id. The person who saw the preview is the person who commits.
- **Time-boxed:** short `exp` (recommend 5 min) limits the confirm window.

### 6.3 Replay safety

Single-use: on successful commit, record `jti` (e.g. a small `assistant_action_confirmations`
table, or reuse an existing idempotency store) and reject any second presentation of the same
`jti`. Combined with the short TTL this makes a captured token useless after one use or five
minutes. (Open decision D5 — new table vs. reuse an existing idempotency mechanism.)

## 7. First action set (design each; recommend the subset)

| # | Action | Mode | Writes? | Maker-checker? | Reuses | Risk |
|---|---|---|---|---|---|---|
| a | **draft_chargeback_match** — for a residual (`factor_chargebacks.disposition='open'`, unmatched) chargeback, propose the single unambiguous invoice via `matchChargeback()`; confirm writes the link through the existing chargebacks disposition/owner PATCH (`finance_misc:write`) | write_confirm | link only, **no money** | No | `chargebackMatch.js` + chargebacks PATCH route | Low — a link, reversible; matcher already refuses ambiguous |
| b | **draft_manual_je** — assistant proposes balanced lines + description + reason; confirm submits the **same** body the human JE screen submits → `requestIfRequired({kind:"je_manual_post"})`; ≥ threshold ⇒ 202 held, a *different* human approves; `created_by` = confirming operator | write_confirm | GL post | **Yes** (existing) | `journal-entries/index.js`, `decide.js` hook, `requireReason` | Medium — but rides the exact human path; self-approval already blocked |
| c | **draft_case** — propose a case (title/body/links) in the cases/M47 queue; confirm inserts | draft | case insert | No | cases_inbox pack module | Low |
| d | **draft_vendor_email** / **draft_customer_email** — compose a CEO-copyable draft (no send, no store); returns text only | read/compose | **none** | No | none — pure compose | Very low (nothing is written) |

**Recommendation — ship the handshake before the ledger:**
- **P28-4-2 = (a) chargeback match** as the flagship: it exercises the *entire* preview→token→
  confirm→RBAC→write pipeline end-to-end **without touching money**, so the confirmation machinery
  is proven on a reversible link before any GL post depends on it.
- **P28-4-3 = (b) draft manual JE** — the maker-checker integration, once the handshake is trusted.
- **(d) email** is compose-only (writes nothing) and can ride P28-4-2 cheaply since it needs no
  token; **(c) case** follows in P28-4-4.

Rationale: (d) needs none of the token/commit machinery (it is effectively an `answer_text` with a
copyable block), and (a) is the smallest *real* write that still forces us to get the token,
RBAC-at-commit, and replay defenses right.

## 8. Guardrails & non-goals

- **No autonomous writes, ever.** No cron, no model turn, no executor writes without a human Confirm
  click verified against a signed token. (Reaffirms P28 §9.)
- **The model never holds the write path.** `commit()` is unreachable from `run_action`; it exists
  only behind the authenticated confirm endpoint.
- **Money always double-gates:** confirm-gate **and** maker-checker. The assistant produces the same
  202-held `approval_request` a human maker produces; approval requires a *different* authenticated
  human; the assistant cannot approve (no `entity_users` identity).
- **RBAC is authoritative at commit,** advisory at preview. Because ask-grid is same-origin-only and
  does not verify a JWT (`ask-grid.js` L80-93, 111-114), the *write* must re-authenticate and
  re-check permissions server-side.
- **T11 reason on every post.** Draft-JE (and any future posting action) carries `reason` in its
  payload; `requireReason("POST", …)` still guards the underlying handler.
- **No new approvals engine, no new posting engine, no new permission system, no card processor.**
- **No auto-send of email** — draft only (CEO-not-admin rule).

## 9. Chunk plan (implementation gate — needs approval)

| Chunk | Scope | Est |
|---|---|---|
| **P28-4-1** | Contract + plumbing, **no user-facing write yet**: extend `validatePack` for `actions[]` + `allActionNames`/`actionByName`; add `run_action` tool + `tool_run_action` executor (read + preview only) + `present_confirmation` terminal tool; confirmation-token sign/verify module (reusing the appJwt HMAC pattern) + unit tests; Confirm-card render + confirm-fetch in `AskAIPanel.tsx`; confirm endpoint skeleton (auth + token verify + RBAC, commit stubbed). | 1 PR |
| **P28-4-2** | **draft_chargeback_match** (action a) end-to-end + replay store (D5) + `draft_vendor_email`/`draft_customer_email` compose (action d, no write) + user-guide chapter + BUILD-PROGRESS. | 1 PR |
| **P28-4-3** | **draft_manual_je** (action b) — `commit()` wraps the existing JE handler path through `requestIfRequired`; asserts 202-held + self-approval-forbidden in tests using the maker-checker fixtures already in `api/_lib/__tests__/maker-checker-rules.test.js`. | 1 PR |
| **P28-4-4** | **draft_case** (action c); optional **draft_ap_payment** if D3 says money-movement drafts are in v1; polish + coverage. | 1 PR |

Each chunk: isolated branch off `origin/main`, `#N`-prefixed PR, squash auto-merge on CI green,
user-guide update in the same PR, BUILD-PROGRESS bump.

## 10. Open decisions for the CEO

- **D1 — First real write.** Recommend chargeback-match (a) first (no money), then draft-JE (b).
  Reorder if you'd rather prove the maker-checker path first.
- **D2 — Draft-JE authorship.** Does the assistant **propose the lines** (operator edits/confirms),
  or must the operator **pre-fill** the JE and the assistant only formats/validates + submits?
  Recommend: assistant proposes lines for *reclasses it can source deterministically*
  (e.g. "move ROF ecom 4005→4011"), operator-prefill for everything else — never invent an account.
- **D3 — Money-movement drafts in v1?** Draft-JE only, or also draft AP payments (action)? Recommend
  JE only in v1; AP payments after the JE path is proven in production.
- **D4 — Dollar thresholds.** Do assistant-originated drafts use the **same** `approval_rules`
  thresholds as the human path (recommended — one rule set, no assistant-specific loophole), or a
  lower assistant-specific threshold (more conservative)?
- **D5 — Replay store.** New `assistant_action_confirmations(jti, …)` table, or reuse an existing
  idempotency mechanism? (Migration size depends on this.)
- **D6 — Email scope.** Is compose-only email (no send, no store) in v1 (recommended — it is nearly
  free and matches the CEO-copyable rule), or deferred until a send channel exists?
- **D7 — Confirm-window TTL.** 5 minutes proposed; longer risks stale previews, shorter annoys.

## 11. Divergences from the parent arch (so the contract can be adjusted)

The parent §4/§6 assumed things that the **as-built** Phases 1-3 code does slightly differently.
Flagging so the parent doc / contract can be reconciled:

1. **`validatePack` does not know about `actions`.** Parent §4 lists `actions` in the pack shape,
   but the built `registry.js` `validatePack()` (L35-55) and `allProviderKeys()` (L59-67) only
   cover `todos`/`processes`/`suggestions`/`panels`. Phase 4 **must extend** the validator — this is
   expected (parent §6 explicitly deferred `run_action` "no pack registers actions yet"), but it
   means the pack contract genuinely changes, not merely "fills in".
2. **`run(db, input, ctx)` → `preview()` + `commit()`.** Parent §4 specifies a single
   `run(db, input, ctx)` with a `mode` flag. This doc **refines** that to two functions so the
   model-reachable surface (`preview`) is physically unable to write and only the authenticated
   endpoint can reach `commit`. Recommend updating parent §4's shape to match. (Provider `run`
   signatures elsewhere are `run(admin, ctx)` 2-arg; actions add the middle `input` arg — a minor
   inconsistency worth noting in the parent.)
3. **Parent §6: "confirm re-invokes with a signed confirmation token."** As-built, the ask-grid loop
   returns `actions[]` to the client and has no second server round-trip. This doc makes the
   round-trip concrete: the confirm is a **separate authenticated endpoint**, not a re-invocation of
   ask-grid — because ask-grid is same-origin-only and does not verify a JWT, so it is the wrong
   place to perform a write. This is a hardening of §6, and the single most important contract
   correction: **the write cannot live on the ask-grid endpoint.**
4. **`ctx.today` vs `ctx.todayISO`.** Parent §4 names the field `today`; the built aggregator
   (`today.js` `buildToday`, `context.js`) uses `todayISO`. Actions should use `todayISO` to match
   the shipped lens.
5. **`ai_insights` table name.** Parent §5 references `ip_ai_insights`; the built aggregator queries
   `ai_insights` (`today.js` L119). Not a Phase-4 concern, but the parent's schema note is stale.

## 12. Risks

1. **Same-origin ask-grid trusts `body.user_id`.** If the confirm endpoint reused that trust it
   would be forgeable. Mitigation: confirm authenticates a real identity and binds the token `sub`
   to it (§5.3, §6.2). **This is the top risk and the reason confirm is its own endpoint.**
2. **Preview/commit drift.** A stale or mutated payload could post the wrong thing. Mitigation: the
   token binds `sha256(canonicalJSON(commit_payload))`; commit re-hashes and 409s on mismatch (§6).
3. **Replay.** Mitigation: single-use `jti` + short TTL (§6.3).
4. **Assistant proposes a wrong JE.** Mitigation: it never posts — a human confirms *and* (≥
   threshold) a second human approves; below threshold it is still one explicit human confirm. The
   Xoro-GL-is-truth rule (memory: no heuristic postings) means draft-JE should propose lines only
   for deterministically sourced reclasses (D2), never guessed account classifications.
5. **Chargeback mis-link.** Mitigation: `matchChargeback` already returns `null` on any ambiguous
   key (`chargebackMatch.js` L53, L76) — the action proposes only single, exact/suffix-unambiguous
   candidates, and the link is reversible.
6. **Token secret unset in an environment.** Mitigation: fail-closed — write actions are unavailable
   (503 at confirm), preview still works; identical gating discipline to `appJwt.isAppJwtEnabled()`.
7. **Loop-contract churn.** Mitigation: the Confirm card reuses the existing `actions[]` terminal
   channel (`open_panel` precedent) — no rewrite of either ask-grid loop.
</content>
</invoke>
