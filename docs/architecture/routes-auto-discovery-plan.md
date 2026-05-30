# Plan: filesystem-based route auto-discovery (retire the `routes.js` registry)

**Status:** proposed · **Author:** automated (2026-05-30) · **Effort:** ~0.5–1 day, two PRs

## Why

`api/_handlers/routes.js` is a single, hand-maintained, **append-only** file: every handler is imported under a globally-sequential alias (`h0`…`h528`) and registered as a `{ pattern, handler }` row in one big `ROUTES` array.

With multiple agents/PRs in flight, **every** new endpoint appends an import + a route at the *same* spot and grabs the *same* next number → a guaranteed merge conflict. In the 2026-05-30 backlog cleanup, this one file caused ~14 of the 19 PR conflicts and forced per-PR handler-renumbering (h462→h513, etc.). It also produced silent duplicate-import bugs (two `import h475`) that git auto-merge didn't flag.

**This is the single highest-leverage structural fix** for keeping PRs mergeable.

## Goal

Derive the route table from the filesystem at build/startup — no central file to conflict on. Adding an endpoint becomes "drop a handler file at the right path"; nothing else to edit, nothing to renumber.

## Current contract to preserve

- `routes.js` exports `ROUTES` (`{ pattern, handler }[]`) + `compileRoutes()`; the dispatcher matches `req` path against compiled patterns **in array order** (first match wins).
- **Ordering matters:** sub-path routes must precede bare `/:id` (e.g. `/recon/variances/:id/clear` before `/recon/variances`). The hand-list encodes this by position.
- Param convention: the dispatcher passes params via `req.query.id` (NOT `params.id`) — see `feedback_dispatcher_query_not_params`.
- Handlers live under `api/_handlers/{internal,vendor,...}/...`; cron handlers under `api/cron/*`.

## Approach (incremental, behavior-preserving)

**PR 1 — add discovery + an equivalence gate (no behavior change):**
1. Add `api/_handlers/discoverRoutes.js`: glob `api/_handlers/**/*.js` (excluding `routes.js`, `__tests__`, `_lib`), and map each file path → route pattern, Next.js-style:
   - `internal/recon/run-ar.js` → `/api/internal/recon/run-ar`
   - `internal/sales-reps/[id].js` → `/api/internal/sales-reps/:id`
   - `internal/sales-reps/[id]/tiers.js` → `/api/internal/sales-reps/:id/tiers`
   - `index.js` → the bare directory path.
   - cron handlers (`api/cron/*.js`) → `/api/cron/<name>`.
2. **Specificity sort** the discovered routes so static segments and longer paths precede `/:param` and shorter paths (reproduces the hand-ordering rule deterministically).
3. Add a test `routes-equivalence.test.js` that builds the discovered table and asserts its `{pattern → handler-file}` set is **identical** to the current hand-maintained `ROUTES`. This is the safety gate — it must be green before flipping. Any mismatch reveals a special-cased pattern (see Edge cases) to handle explicitly.

**PR 2 — flip + delete the registry (once PR 1's equivalence test is green):**
4. Point the dispatcher at `discoverRoutes()` (keep `compileRoutes()` + matching + the `req.query.id` param extraction unchanged).
5. Delete the `hNNN` imports + `ROUTES` array from `routes.js` (or delete the file).
6. Retire `feedback_routes_js_append_dont_regen` — the footgun it guards against no longer exists.

## Edge cases to audit (PR 1 surfaces them via the equivalence test)

- Patterns that don't map 1:1 to a file path (any hand-written pattern that diverges from its handler's location) — handle with an explicit per-file override map or by relocating the file.
- Method-specific dispatch (GET vs POST on the same path) — confirm the current dispatcher keys only on path; if a file serves multiple methods it already branches internally, so one route row per file still holds.
- `vercel.json` cron registration is a **separate** list (the schedule, not the route) — out of scope here, but note it's the *other* append-only file that collides; a follow-up could generate it from `api/cron/*` too.

## Payoff

- New endpoint = new file. Zero edits to a shared file → **no more routes.js merge conflicts**, no handler renumbering, no duplicate-import bugs.
- The equivalence test makes the migration provably behavior-preserving.

## Non-goals

- No change to handler signatures, the dispatcher's matching algorithm, or the param convention.
- Not auto-generating `vercel.json` crons (separate, smaller follow-up).
