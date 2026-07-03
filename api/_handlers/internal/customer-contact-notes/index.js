// api/internal/customer-contact-notes
//
// Notes (+ optional reminder) on a customer AP/Trans/CB contact (operator #12).
//
// GET    ?customer_id=<uuid>[&contact_id=<id>]  → notes, newest first.
// POST   { customer_id, contact_id, body, created_by_user_id?, created_by_name?,
//          remind_at? }                          → create one note.
//          remind_at (ISO) sets a reminder; the contact-reminders cron notifies
//          created_by_user_id when it's due.
// DELETE ?id=<uuid>                              → delete one note.
//
// Service-role writes (RLS denies anon). Not entity-scoped — keyed by customer.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLS = "id, customer_id, contact_id, body, created_by_user_id, created_by_name, created_at, remind_at, reminder_sent";

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);

  if (req.method === "GET") {
    const customerId = (url.searchParams.get("customer_id") || "").trim();
    if (!UUID_RE.test(customerId)) return res.status(400).json({ error: "customer_id (uuid) required" });
    const contactId = (url.searchParams.get("contact_id") || "").trim();
    let q = admin.from("customer_contact_notes").select(COLS)
      .eq("customer_id", customerId).order("created_at", { ascending: false }).limit(500);
    if (contactId) q = q.eq("contact_id", contactId);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    body = body || {};
    const customerId = String(body.customer_id || "").trim();
    const contactId = String(body.contact_id || "").trim();
    const text = String(body.body || "").trim();
    if (!UUID_RE.test(customerId)) return res.status(400).json({ error: "customer_id (uuid) required" });
    if (!contactId) return res.status(400).json({ error: "contact_id required" });
    if (!text) return res.status(400).json({ error: "body required" });
    let remindAt = null;
    if (body.remind_at) {
      const d = new Date(body.remind_at);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ error: "remind_at must be a valid date/time" });
      remindAt = d.toISOString();
    }
    const row = {
      customer_id: customerId,
      contact_id: contactId,
      body: text,
      created_by_user_id: body.created_by_user_id && UUID_RE.test(String(body.created_by_user_id)) ? body.created_by_user_id : null,
      created_by_name: body.created_by_name ? String(body.created_by_name).trim() : null,
      remind_at: remindAt,
    };
    const { data, error } = await admin.from("customer_contact_notes").insert(row).select(COLS).single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  if (req.method === "DELETE") {
    const id = (url.searchParams.get("id") || "").trim();
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "id (uuid) required" });
    const { error } = await admin.from("customer_contact_notes").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  res.setHeader("Allow", "GET, POST, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
