// api/internal/ai/mention-suggest
//
// Autocomplete endpoint for the Ask AI @mention dropdown (PR 2/4).
//
// GET ?q=&type=customer|style → { items: [{ id, label, sublabel }] }
//
// All real lookup logic lives in api/_lib/ai/mentions.js (per the
// architecture invariant — handler stays thin). Auth: bearer token
// via authenticateInternalCaller (same as the other internal AI
// endpoints).

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";
import { suggestMentions } from "../../../_lib/ai/mentions.js";

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const SB_URL      = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Supabase not configured" });
  const db = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const query = String(req.query?.q || "").slice(0, 80);
  const type  = String(req.query?.type || "").slice(0, 16);
  const out = await suggestMentions(db, { query, type });
  if (out.error) return res.status(400).json({ error: out.error, items: [] });
  return res.status(200).json({ items: out.items || [] });
}
