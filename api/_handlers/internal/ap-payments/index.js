// api/internal/ap-payments
//
// GET — list invoice_payments (read-only ledger). Filters:
//         ?invoice_id=<uuid>
//         ?method=<ach|wire|check|credit_card|cash>
//         ?from=<YYYY-MM-DD> / ?to=<YYYY-MM-DD>  (payment_date window)
//         ?limit=N (default 100, max 500)
//
// All write paths flow through /api/internal/ap-invoices/:id/pay — this
// endpoint exists only for reporting/admin display.
//
// Tangerine P3 Chunk 2.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHODS = ["ach", "wire", "check", "credit_card", "cash"];

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

async function resolveDefaultEntityId(admin) {
  const { data, error } = await admin
    .from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (error || !data) return null;
  return data.id;
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

  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const invoiceId = (url.searchParams.get("invoice_id") || "").trim();
  const method    = (url.searchParams.get("method") || "").trim();
  const from      = (url.searchParams.get("from") || "").trim();
  const to        = (url.searchParams.get("to") || "").trim();
  let limit = parseInt(url.searchParams.get("limit") || "100", 10);
  if (Number.isNaN(limit) || limit < 1) limit = 100;
  if (limit > 500) limit = 500;

  if (invoiceId && !UUID_RE.test(invoiceId)) {
    return res.status(400).json({ error: "invoice_id must be a uuid" });
  }
  if (method && !METHODS.includes(method)) {
    return res.status(400).json({ error: `method must be one of ${METHODS.join(", ")}` });
  }
  if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    return res.status(400).json({ error: "from must be YYYY-MM-DD" });
  }
  if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: "to must be YYYY-MM-DD" });
  }

  let query = admin
    .from("invoice_payments")
    .select(
      "id, entity_id, invoice_id, payment_date, amount_cents, bank_account_id, " +
      "method, reference, cash_je_id, notes, created_at, created_by_user_id"
    )
    .eq("entity_id", entityId)
    .order("payment_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (invoiceId) query = query.eq("invoice_id", invoiceId);
  if (method)    query = query.eq("method", method);
  if (from)      query = query.gte("payment_date", from);
  if (to)        query = query.lte("payment_date", to);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data || []);
}

// Re-export filter-validation logic for tests.
export function validateFilters({ invoice_id, method, from, to }) {
  if (invoice_id && !UUID_RE.test(invoice_id)) return { error: "invoice_id must be a uuid" };
  if (method && !METHODS.includes(method)) {
    return { error: `method must be one of ${METHODS.join(", ")}` };
  }
  if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) return { error: "from must be YYYY-MM-DD" };
  if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) return { error: "to must be YYYY-MM-DD" };
  return { data: { invoice_id, method, from, to } };
}
