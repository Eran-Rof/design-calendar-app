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

// Supabase JS client — used for Realtime subscriptions
export const supabaseClient = createClient(SB_URL, SB_KEY);
