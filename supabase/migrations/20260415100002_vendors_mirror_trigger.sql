-- 0002_vendors_mirror_trigger.sql
--
-- Keeps vendors table in sync with app_data['vendors'] JSON blob without
-- touching internal app code. Fires on INSERT/UPDATE of the app_data row
-- where key='vendors', diffs OLD vs NEW JSON arrays, and upserts vendors
-- accordingly. Vendors removed from the JSON are soft-deleted (deleted_at
-- set) rather than hard-deleted so FKs from tanda_pos remain valid.
--
-- Also seeds the vendors table one-time from the current blob — safe to
-- re-run: ON CONFLICT DO UPDATE on legacy_blob_id.

-- ── mirror function ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mirror_vendors_blob()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER   -- run as table owner so it bypasses any RLS we add later
SET search_path = public
AS $$
DECLARE
  new_arr jsonb;
  old_arr jsonb;
  rec     jsonb;
  new_ids text[] := '{}';
BEGIN
  -- app_data.value is stored as a JSON-encoded string (text column), so the
  -- client has called JSON.stringify twice effectively — we need to parse once.
  BEGIN
    new_arr := NEW.value::jsonb;
  EXCEPTION WHEN others THEN
    -- value isn't valid JSON; nothing we can mirror.
    RETURN NEW;
  END;

  IF jsonb_typeof(new_arr) <> 'array' THEN
    RETURN NEW;
  END IF;

  -- Upsert every vendor in the new array.
  FOR rec IN SELECT * FROM jsonb_array_elements(new_arr)
  LOOP
    IF rec ? 'id' AND rec ? 'name' THEN
      INSERT INTO vendors (
        legacy_blob_id, name, country, transit_days, categories,
        contact, email, moq, lead_overrides, wip_lead_overrides,
        deleted_at, updated_at
      )
      VALUES (
        rec->>'id',
        rec->>'name',
        rec->>'country',
        NULLIF(rec->>'transitDays','')::int,
        COALESCE(
          ARRAY(SELECT jsonb_array_elements_text(rec->'categories')),
          '{}'
        ),
        rec->>'contact',
        rec->>'email',
        NULLIF(rec->>'moq','')::int,
        COALESCE(rec->'leadOverrides', '{}'::jsonb),
        COALESCE(rec->'wipLeadOverrides', '{}'::jsonb),
        NULL,                       -- un-soft-delete if previously removed
        now()
      )
      ON CONFLICT (legacy_blob_id) DO UPDATE SET
        name               = EXCLUDED.name,
        country            = EXCLUDED.country,
        transit_days       = EXCLUDED.transit_days,
        categories         = EXCLUDED.categories,
        contact            = EXCLUDED.contact,
        email              = EXCLUDED.email,
        moq                = EXCLUDED.moq,
        lead_overrides     = EXCLUDED.lead_overrides,
        wip_lead_overrides = EXCLUDED.wip_lead_overrides,
        deleted_at         = NULL,
        updated_at         = now();

      new_ids := array_append(new_ids, rec->>'id');
    END IF;
  END LOOP;

  -- Soft-delete vendors that existed in the OLD blob but are absent from NEW.
  IF TG_OP = 'UPDATE' AND OLD.value IS NOT NULL THEN
    BEGIN
      old_arr := OLD.value::jsonb;
    EXCEPTION WHEN others THEN
      old_arr := NULL;
    END;

    IF old_arr IS NOT NULL AND jsonb_typeof(old_arr) = 'array' THEN
      UPDATE vendors
         SET deleted_at = now(),
             updated_at = now()
       WHERE deleted_at IS NULL
         AND legacy_blob_id = ANY (
           ARRAY(
             SELECT elem->>'id'
               FROM jsonb_array_elements(old_arr) elem
              WHERE elem ? 'id'
           )
         )
         AND legacy_blob_id <> ALL (new_ids);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ── trigger on app_data ──────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_mirror_vendors_blob ON app_data;

CREATE TRIGGER trg_mirror_vendors_blob
AFTER INSERT OR UPDATE OF value ON app_data
FOR EACH ROW
WHEN (NEW.key = 'vendors')
EXECUTE FUNCTION mirror_vendors_blob();

-- ── one-time seed from existing blob ─────────────────────────────────────────
-- Re-runs the mirror logic against the current row so the vendors table
-- is populated immediately (the trigger above only fires on future writes).
DO $$
DECLARE
  cur_value text;
  arr jsonb;
  rec jsonb;
BEGIN
  SELECT value INTO cur_value FROM app_data WHERE key = 'vendors' LIMIT 1;
  IF cur_value IS NULL THEN
    RETURN;
  END IF;

  BEGIN
    arr := cur_value::jsonb;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'app_data.vendors.value is not valid JSON; skipping seed';
    RETURN;
  END;

  IF jsonb_typeof(arr) <> 'array' THEN
    RETURN;
  END IF;

  FOR rec IN SELECT * FROM jsonb_array_elements(arr) LOOP
    IF rec ? 'id' AND rec ? 'name' THEN
      INSERT INTO vendors (
        legacy_blob_id, name, country, transit_days, categories,
        contact, email, moq, lead_overrides, wip_lead_overrides
      )
      VALUES (
        rec->>'id',
        rec->>'name',
        rec->>'country',
        NULLIF(rec->>'transitDays','')::int,
        COALESCE(
          ARRAY(SELECT jsonb_array_elements_text(rec->'categories')),
          '{}'
        ),
        rec->>'contact',
        rec->>'email',
        NULLIF(rec->>'moq','')::int,
        COALESCE(rec->'leadOverrides', '{}'::jsonb),
        COALESCE(rec->'wipLeadOverrides', '{}'::jsonb)
      )
      ON CONFLICT (legacy_blob_id) DO NOTHING;
    END IF;
  END LOOP;
END;
$$;
