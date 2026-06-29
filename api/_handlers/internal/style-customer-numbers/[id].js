// api/internal/style-customer-numbers/[id]
//
// PATCH  — update customer_style_number / notes / customer_id.
// DELETE — remove the mapping.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SELECT = "id, style_id, customer_id, customer_style_number, notes, created_at, updated_at, customer:customers!style_customer_numbers_customer_id_fkey (id, name, code, customer_code)";

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PATCH, DELETE, OPTIONS");
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

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: "Invalid id" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    body = body || {};
    const out = {};
    if ("customer_style_number" in body) {
      if (!String(body.customer_style_number || "").trim()) return res.status(400).json({ error: "customer_style_number cannot be empty" });
      out.customer_style_number = String(body.customer_style_number).trim();
    }
    if ("customer_id" in body) {
      if (!UUID_RE.test(String(body.customer_id))) return res.status(400).json({ error: "customer_id must be a uuid" });
      out.customer_id = String(body.customer_id);
    }
    if ("notes" in body) out.notes = body.notes != null && String(body.notes).trim() !== "" ? String(body.notes).trim() : null;
    if (Object.keys(out).length === 0) return res.status(400).json({ error: "No mutable fields supplied" });

    const { data, error } = await admin.from("style_customer_numbers").update(out).eq("id", id).select(SELECT).single();
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ error: "Mapping not found" });
      if (error.code === "23505") return res.status(409).json({ error: "This customer already has a style number mapped for this style" });
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    const { data, error } = await admin.from("style_customer_numbers").delete().eq("id", id).select("id").maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Mapping not found" });
    return res.status(200).json({ deleted: true, id });
  }

  res.setHeader("Allow", "PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
