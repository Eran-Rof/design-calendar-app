// api/internal/ar-collections/activities
//
// GET  ?customer=<uuid>[&ar_invoice_id=<uuid>] — activity timeline (newest first)
//        for a customer (optionally narrowed to one invoice). Includes
//        customer-level activities (ar_invoice_id IS NULL) alongside the
//        invoice's own when ar_invoice_id is given.
// POST — log a collection activity. Operator data only: writes to
//        ar_collection_activities. NEVER posts GL, NEVER mutates invoices.
//        Body: { customer_id, ar_invoice_id?, activity_type, outcome,
//                promise_amount_cents?, promise_date? }
//        outcome is mandatory; promise_to_pay requires promise_amount_cents +
//        promise_date.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller, resolveUserId } from "../../../_lib/auth.js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TYPES = ["note", "call", "email", "promise_to_pay", "dispute", "escalation", "payment_expected"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token, X-Entity-ID, X-Auth-User-Id");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function resolveDefaultEntityId(admin) {
  const { data, error } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (error || !data) return null;
  return data.id;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const customer = (url.searchParams.get("customer") || "").trim();
    const invoice = (url.searchParams.get("ar_invoice_id") || "").trim();
    if (!UUID_RE.test(customer)) return res.status(400).json({ error: "customer must be a UUID" });
    let q = admin
      .from("ar_collection_activities")
      .select("id, customer_id, ar_invoice_id, activity_type, promise_amount_cents, promise_date, outcome, created_by_user_id, created_at")
      .eq("customer_id", customer);
    if (invoice) {
      if (!UUID_RE.test(invoice)) return res.status(400).json({ error: "ar_invoice_id must be a UUID" });
      // Invoice timeline = the invoice's own activities + customer-level ones.
      q = q.or(`ar_invoice_id.eq.${invoice},ar_invoice_id.is.null`);
    }
    q = q.order("created_at", { ascending: false }).limit(500);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ rows: data || [] });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const user = await resolveUserId(req, admin);
  if (!user.ok) return res.status(user.status).json({ error: user.error });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const customer_id = String(body?.customer_id || "").trim();
  const ar_invoice_id = body?.ar_invoice_id ? String(body.ar_invoice_id).trim() : null;
  const activity_type = String(body?.activity_type || "").trim();
  const outcome = String(body?.outcome || "").trim();

  if (!UUID_RE.test(customer_id)) return res.status(400).json({ error: "customer_id must be a UUID" });
  if (ar_invoice_id && !UUID_RE.test(ar_invoice_id)) return res.status(400).json({ error: "ar_invoice_id must be a UUID" });
  if (!TYPES.includes(activity_type)) return res.status(400).json({ error: `activity_type must be one of ${TYPES.join(", ")}` });
  if (!outcome) return res.status(400).json({ error: "outcome is required" });
  if (outcome.length > 2000) return res.status(400).json({ error: "outcome must be <= 2000 chars" });

  let promise_amount_cents = null;
  let promise_date = null;
  if (activity_type === "promise_to_pay") {
    promise_amount_cents = Number(body?.promise_amount_cents);
    promise_date = String(body?.promise_date || "").trim();
    if (!Number.isFinite(promise_amount_cents) || promise_amount_cents <= 0) {
      return res.status(400).json({ error: "promise_amount_cents must be a positive integer for a promise_to_pay" });
    }
    promise_amount_cents = Math.round(promise_amount_cents);
    if (!ISO_DATE_RE.test(promise_date)) return res.status(400).json({ error: "promise_date must be YYYY-MM-DD for a promise_to_pay" });
  }

  try {
    const entityId = await resolveDefaultEntityId(admin);
    if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

    const { data, error } = await admin
      .from("ar_collection_activities")
      .insert({
        entity_id: entityId,
        customer_id,
        ar_invoice_id,
        activity_type,
        promise_amount_cents,
        promise_date,
        outcome,
        created_by_user_id: user.authId,
      })
      .select("id, customer_id, ar_invoice_id, activity_type, promise_amount_cents, promise_date, outcome, created_by_user_id, created_at")
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ activity: data });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
