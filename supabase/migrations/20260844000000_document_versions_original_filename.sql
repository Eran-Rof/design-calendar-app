-- Retain the ORIGINAL uploaded filename on each document version.
--
-- The documents API names the STORAGE object `vN.ext` (deterministic version
-- layout — see _lib/documents/index.js). That is intentional for the bucket
-- layout, but it means a download had no real filename: the browser would save
-- the file as `v1.xlsx` instead of the user's `Q3-costing.xlsx`.
--
-- We persist the original filename per VERSION (each version is a distinct
-- uploaded file, so the name can legitimately differ between versions) and pass
-- it as the Content-Disposition filename when minting the signed download URL.
--
-- Nullable + no backfill: pre-existing versions keep falling back to the
-- document title / storage basename, which is the prior behaviour.
ALTER TABLE document_versions
  ADD COLUMN IF NOT EXISTS original_filename text;

COMMENT ON COLUMN document_versions.original_filename IS 'Original client-side filename at upload time; used as the download (Content-Disposition) filename.';
