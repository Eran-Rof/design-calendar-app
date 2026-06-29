-- Backfill a true creation date onto every Design Calendar collection.
--
-- The Design Calendar "Created" date reads collections.data->>'createdAt'.
-- New collections stamp it at creation (addCollection), but collections that
-- pre-date that feature have createdAt = null and were briefly displayed using
-- data->>'_updatedAt' (the LAST-SAVE time) — which is misleading.
--
-- The collections table has no row-insert column other than `updated_at`
-- (default now(), and never bumped afterwards: the upsert writes only id+data
-- and there is no UPDATE trigger), so `updated_at` reliably holds the row's
-- original insert time = the collection's true creation moment. Copy it into
-- data.createdAt for any row that's still missing one.
--
-- Idempotent: only touches rows where createdAt is absent, so re-running (and
-- running on environments where prod was already fixed by hand) is a no-op.

update collections
set data = jsonb_set(data, '{createdAt}', to_jsonb(updated_at))
where data->>'createdAt' is null;
