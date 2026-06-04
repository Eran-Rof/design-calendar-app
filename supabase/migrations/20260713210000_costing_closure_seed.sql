-- 20260713210000_costing_closure_seed.sql
--
-- Seed the Costing "Bottom Closure" master with the standard closure types.
--
-- The costing masters (fit / closure / waist / comment / fabric) are stored
-- as JSON blobs in the public.app_data key-value table. The closure master
-- lives under key 'costing_closures' and its value is a JSON-stringified
-- array of { id, name } entries (matching MasterEntry on the client; the
-- store serializes via JSON.stringify, so value is a text/JSON string).
--
-- This migration is fully idempotent: it merges the six default closures
-- into whatever already exists, adding only the names that are not already
-- present (case-insensitive). Existing entries (and their client-generated
-- ids) are preserved. Running it twice is a no-op.

DO $$
DECLARE
  defaults text[] := ARRAY[
    'Fixed waist with adjuster',
    'Elastic waist',
    'Side zip closure',
    'Snap button closure',
    'Button closure',
    'Drawcord'
  ];
  existing  jsonb;
  have      jsonb := '[]'::jsonb;   -- lowercased names already present
  merged    jsonb;
  nm        text;
BEGIN
  -- Current value parsed as a JSON array (empty array if missing/blank).
  SELECT COALESCE(NULLIF(value, '')::jsonb, '[]'::jsonb)
    INTO existing
    FROM public.app_data
   WHERE key = 'costing_closures';

  IF existing IS NULL THEN
    existing := '[]'::jsonb;
  END IF;

  -- Build a set of lowercased names already in the master.
  SELECT COALESCE(jsonb_agg(lower(elem->>'name')), '[]'::jsonb)
    INTO have
    FROM jsonb_array_elements(existing) AS elem;

  merged := existing;

  FOREACH nm IN ARRAY defaults LOOP
    IF NOT (have ? lower(nm)) THEN
      merged := merged || jsonb_build_array(
        jsonb_build_object('id', gen_random_uuid()::text, 'name', nm)
      );
      have := have || to_jsonb(lower(nm));
    END IF;
  END LOOP;

  -- Upsert the merged blob back as a JSON string (value is text).
  INSERT INTO public.app_data (key, value)
  VALUES ('costing_closures', merged::text)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
END $$;
