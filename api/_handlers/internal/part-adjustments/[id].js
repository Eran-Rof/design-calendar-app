// api/internal/part-adjustments/[id]
//
// GET — fetch a single part_adjustments row. Adjustments are immutable once
//       created+posted (no PATCH/DELETE); correct a mistake with an opposing
//       adjustment.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: "Invalid id" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data, error } = await admin.from("part_adjustments").select("*").eq("id", id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Part adjustment not found" });
  return res.status(200).json(data);
}
