-- ════════════════════════════════════════════════════════════════════════════
-- P28-4-2 — Assistant draft-action replay store (recovered migration)
--
-- ⚠️ RECOVERY: the handler api/_handlers/internal/assistant/actions-confirm.js
-- (merged, on main) references table `assistant_action_confirmations`, but its
-- migration was never committed — a P28 agent left it as an untracked local file
-- at version 20260996000000, which collided with (and was shadowed by) the
-- already-applied retailer-EDI migration, so db-push silently skipped it and the
-- table was NEVER created in prod (a latent runtime bug: every /assistant/actions/
-- confirm call would 500 on a missing relation). The coordinator applied the
-- table operationally to prod on 2026-07-15 to stop the bleeding; this migration
-- commits it at a clean, unique version so new environments and future rebuilds
-- get it too. Idempotent (CREATE TABLE IF NOT EXISTS) → a no-op on prod.
--
-- Per docs/tangerine/P28-4-draft-actions-architecture.md section 6.3.
-- The confirm endpoint commits a model-drafted, operator-confirmed write exactly
-- once per confirmation token. Every token carries a random `jti`; a successful
-- confirm INSERTs that jti here. A replayed token hits the PK conflict and is
-- rejected 409 (token_already_used); combined with the 5-min TTL a captured
-- token is useless after one use. Idempotency ledger, not an audit trail — the
-- action's own write carries the audit.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS assistant_action_confirmations (
  jti          text PRIMARY KEY,
  entity_id    uuid NOT NULL DEFAULT rof_entity_id(),
  user_id      uuid,
  action       text NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assistant_action_confirmations_user_time
  ON assistant_action_confirmations (user_id, committed_at DESC);

COMMENT ON TABLE assistant_action_confirmations IS
  'P28-4-2 replay store: one row per successfully-committed assistant draft-action confirmation token (jti). A second confirm with the same jti conflicts on the PK and is rejected 409. Idempotency ledger, not an audit trail.';
