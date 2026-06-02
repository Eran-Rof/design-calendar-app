-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P2 / Chunk 1 / Migration 2
-- pending_approval_gate — adds a guard to the JE posting flow that blocks
-- status transition to 'posted' while a pending approval_requests row exists
-- for that specific JE.
--
-- Same shape (context_table='journal_entries', context_id=NEW.id) will be
-- copy-pasted into AP invoice posting (M3), AR invoice send (M4), PO release
-- (M11), etc. when those modules land.
--
-- Per docs/tangerine/P2-cross-cutters-architecture.md §4.4.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION journal_entry_pending_approval_guard() RETURNS trigger AS $$
DECLARE
  pending_request_id uuid;
BEGIN
  -- Only check on transitions INTO 'posted' status.
  IF TG_OP = 'UPDATE' AND (OLD.status = NEW.status OR NEW.status <> 'posted') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.status <> 'posted' THEN
    RETURN NEW;
  END IF;

  SELECT id INTO pending_request_id
    FROM approval_requests
   WHERE context_table = 'journal_entries'
     AND context_id    = NEW.id
     AND status        = 'pending'
   LIMIT 1;

  IF pending_request_id IS NOT NULL THEN
    RAISE EXCEPTION 'journal_entry % cannot post while approval_request % is pending',
      NEW.id, pending_request_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION journal_entry_pending_approval_guard() IS 'Tangerine P2 M27 gate. Blocks JE post while any pending approval_requests row exists for this JE. The application layer should never attempt to post a gated JE; this trigger is the fail-loud safety net.';

-- Run BEFORE the post-guard so the post-guard does not waste a balance check
-- on a JE that will be rejected anyway.
DROP TRIGGER IF EXISTS journal_entries_pending_approval_ins ON journal_entries;
CREATE TRIGGER journal_entries_pending_approval_ins
  BEFORE INSERT ON journal_entries
  FOR EACH ROW
  WHEN (NEW.status = 'posted')
  EXECUTE FUNCTION journal_entry_pending_approval_guard();

DROP TRIGGER IF EXISTS journal_entries_pending_approval_upd ON journal_entries;
CREATE TRIGGER journal_entries_pending_approval_upd
  BEFORE UPDATE ON journal_entries
  FOR EACH ROW
  WHEN (OLD.status <> 'posted' AND NEW.status = 'posted')
  EXECUTE FUNCTION journal_entry_pending_approval_guard();
