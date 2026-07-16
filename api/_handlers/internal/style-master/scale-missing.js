// api/internal/style-master/scale-missing
//
// GET → the style_codes that GENUINELY need a size scale (v_style_scale_missing:
//       no size_scale_id AND a real multi-size run). Backs the Today assistant
//       "styles missing a size scale" drill — Style Master reads scale=missing,
//       fetches this list, and filters its grid to just those styles.
//
// Returns { style_codes: [...], count: N }. Keyset-paginated by style_code so
// the full set survives PostgREST's ~1000-row cap (the set is ~44 today but
// this stays correct if it grows).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const PAGE = 1000;
  const codes = [];
  let after = null;
  for (;;) {
    let q = admin.from("v_style_scale_missing")
      .select("style_code")
      .order("style_code", { ascending: true })
      .limit(PAGE);
    if (after) q = q.gt("style_code", after);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    const page = data || [];
    for (const r of page) if (r.style_code) codes.push(r.style_code);
    if (page.length < PAGE) break;
    after = page[page.length - 1].style_code;
  }

  return res.status(200).json({ style_codes: codes, count: codes.length });
}
