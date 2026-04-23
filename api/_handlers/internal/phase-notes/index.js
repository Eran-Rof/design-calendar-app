// api/internal/phase-notes
//
// GET — list phase notes with vendor/PO context.
//   ?po_id=<uuid>            (required)
//   ?phase_name=<string>     (optional — filter to one phase)

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const poId = url.searchParams.get("po_id");
  const phaseName = url.searchParams.get("phase_name");
  if (!poId) return res.status(400).json({ error: "po_id is required" });

  let q = admin
    .from("po_phase_notes")
    .select("id, vendor_id, po_id, phase_name, po_line_key, body, author_auth_id, author_name, created_at, updated_at")
    .eq("po_id", poId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(500);
  if (phaseName) q = q.eq("phase_name", phaseName);

  const { data: rows, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ rows: rows || [] });
}
