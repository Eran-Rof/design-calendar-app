-- Security-advisor fixes (Supabase lints), two isolated, behavior-preserving changes.
--
-- 1) auth_users_exposed (ERROR): view public.v_audit_user_resolved selects auth.users
--    (every user's email) and `anon`/`authenticated` held SELECT on it, so an anonymous
--    PostgREST caller could enumerate all user emails. The view is consumed ONLY by
--    server-side handlers (api/_handlers/internal/journal-entries/*) which connect as
--    service_role, so revoking anon/authenticated is safe. Kept SECURITY DEFINER on
--    purpose — the server path relies on it; the broader security_definer_view sweep is
--    deferred to the SaaS isolation phase.
REVOKE ALL ON public.v_audit_user_resolved FROM anon, authenticated;

-- 2) public_bucket_allows_listing (WARN): the legacy `Attachments` storage bucket was
--    PUBLIC + listable. It is referenced NOWHERE in application code (all active uploads
--    target private buckets: vendor-docs, tangerine-documents, plm-images, etc.) and the
--    codebase uses no getPublicUrl. Flip it to private; its objects stay, only anonymous
--    list/download is removed.
UPDATE storage.buckets SET public = false WHERE id = 'Attachments';
