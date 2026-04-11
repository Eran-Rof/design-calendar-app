// ── Centralised Supabase config ───────────────────────────────────────────────
// All values come from environment variables — never hardcoded in source files.
// Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env (local) and in the
// Vercel project → Settings → Environment Variables (production).

import { createClient } from "@supabase/supabase-js";

export const SB_URL = ((import.meta.env.VITE_SUPABASE_URL as string) || "").trim();
export const SB_KEY = ((import.meta.env.VITE_SUPABASE_ANON_KEY as string) || "").trim();

export const SB_HEADERS: Record<string, string> = {
  "apikey":        SB_KEY,
  "Authorization": `Bearer ${SB_KEY}`,
  "Content-Type":  "application/json",
  "Prefer":        "return=representation",
};

// Supabase JS client — used for Realtime subscriptions. Guarded so test
// environments without env vars don't throw at module-evaluation time;
// code paths that need the real client will fail at use-site instead,
// which is easier to debug than a boot-time import error.
export const supabaseClient = (SB_URL && SB_KEY)
  ? createClient(SB_URL, SB_KEY)
  : (null as unknown as ReturnType<typeof createClient>);
