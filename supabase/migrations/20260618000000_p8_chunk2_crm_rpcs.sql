-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P8-2 — CRM stage-change RPC (M25, arch §4)
--
-- One SECURITY DEFINER RPC that atomically:
--   1. Locks the crm_opportunities row (SELECT … FOR UPDATE).
--   2. Validates the requested new_stage against the pipeline enum AND that it
--      differs from the current stage.
--   3. Optionally sets the `app.current_user_id` GUC so the P8-1 AFTER UPDATE
--      audit trigger (crm_opp_stage_change_audit_trg) captures the actor.
--   4. UPDATEs stage (the BEFORE-UPDATE trigger touches stage_changed_at +
--      updated_at; the AFTER-UPDATE trigger inserts a stage_change row into
--      crm_activities with payload containing old/new + actor + reason).
--   5. Reads back the just-inserted crm_activities.id (most recent
--      stage_change row for this opp) and returns
--      { opp_id, old_stage, new_stage, activity_id }.
--
-- Errors RAISE EXCEPTION so the handler regex pattern maps them to HTTP 409:
--   - opportunity not found
--   - stage is not a valid enum value
--   - new_stage equals current stage
--
-- See docs/tangerine/P8-data-crm-architecture.md §4.
-- Operator-confirmed via PR #426 §2.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION crm_opp_change_stage(
  p_opp_id        uuid,
  p_new_stage     text,
  p_reason        text DEFAULT NULL,
  p_actor_user_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_opp        crm_opportunities%ROWTYPE;
  v_old_stage  text;
  v_valid      text[] := ARRAY['new','qualified','proposal','won','lost'];
  v_activity_id uuid;
BEGIN
  IF p_opp_id IS NULL THEN
    RAISE EXCEPTION 'opp_id is required';
  END IF;
  IF p_new_stage IS NULL OR NOT (p_new_stage = ANY(v_valid)) THEN
    RAISE EXCEPTION 'new_stage must be one of: %', array_to_string(v_valid, ', ');
  END IF;

  -- Lock the row to serialize concurrent stage-change writers.
  SELECT * INTO v_opp
    FROM crm_opportunities
   WHERE id = p_opp_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'opportunity not found: %', p_opp_id;
  END IF;

  v_old_stage := v_opp.stage;
  IF v_old_stage = p_new_stage THEN
    RAISE EXCEPTION 'opportunity is already in stage: %', p_new_stage;
  END IF;

  -- Make the audit trigger pick up the actor via session GUC.
  IF p_actor_user_id IS NOT NULL THEN
    PERFORM set_config('app.current_user_id', p_actor_user_id::text, true);
  END IF;

  -- Update; BEFORE trigger updates stage_changed_at + updated_at, AFTER trigger
  -- INSERTs the stage_change row into crm_activities.
  -- If a loss_reason is supplied AND we're transitioning to 'lost', stash it.
  IF p_new_stage = 'lost' AND p_reason IS NOT NULL THEN
    UPDATE crm_opportunities
       SET stage = p_new_stage,
           loss_reason = p_reason
     WHERE id = p_opp_id;
  ELSE
    UPDATE crm_opportunities
       SET stage = p_new_stage
     WHERE id = p_opp_id;
  END IF;

  -- Locate the freshly-inserted stage_change activity row. The trigger writes
  -- it with the actor + opp; pick the most recent matching one.
  SELECT id INTO v_activity_id
    FROM crm_activities
   WHERE opportunity_id = p_opp_id
     AND activity_type = 'stage_change'
   ORDER BY occurred_at DESC, created_at DESC
   LIMIT 1;

  -- If a reason was supplied and we're NOT moving to 'lost' (so we didn't
  -- stash it on the opp), append it to the activity row's body for context.
  -- Activity row is immutable EXCEPT is_hidden — body cannot be updated. We
  -- instead let the caller see the reason via the response payload; the
  -- stage-change trigger captures reason indirectly via loss_reason for lost
  -- transitions only. This is acceptable per arch §4.
  RETURN jsonb_build_object(
    'opp_id',      p_opp_id,
    'old_stage',   v_old_stage,
    'new_stage',   p_new_stage,
    'activity_id', v_activity_id,
    'reason',      p_reason
  );
END;
$$;

COMMENT ON FUNCTION crm_opp_change_stage(uuid, text, text, uuid) IS
  'P8-2 M25 stage-change RPC. Atomically locks + updates an opportunity row and lets the P8-1 audit trigger write the stage_change activity. Returns {opp_id, old_stage, new_stage, activity_id, reason}. Raises on bad enum / not-found / already-in-stage; handler maps RAISE to HTTP 409.';

-- ─── PostgREST schema cache reload ─────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
