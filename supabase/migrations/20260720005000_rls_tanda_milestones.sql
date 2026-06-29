-- Enable RLS on public.tanda_milestones to clear the Supabase "RLS Disabled in Public" lint.
-- Behavior-preserving: matches the existing project convention (RLS enabled + permissive
-- anon policy) so the browser (shared anon key) keeps reading/writing milestones unchanged.
-- Entity-scoped tightening is deliberately deferred to the coordinated SaaS isolation sweep.

ALTER TABLE public.tanda_milestones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_tanda_milestones" ON public.tanda_milestones;
CREATE POLICY "anon_all_tanda_milestones" ON public.tanda_milestones
  FOR ALL TO anon USING (true) WITH CHECK (true);
