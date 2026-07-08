// POST /api/sales/upload-payment-state — per-invoice Xoro payment state intake.
//
// The nightly rest_invoice_sync.py already reads FullPaymentDate + payment
// StatusName per invoice header while walking invoice/getinvoice; it now
// pushes {invoice_number, payment_status, full_payment_date}[] here (gzip
// envelope, chunkable — same pattern as tanda/upload-sos). Rows upsert into
// ar_xoro_payment_state; the daily ar-receipts-reconcile cron turns PAID
// states into receipt JEs so Tangerine AR tracks Xoro daily.
//
// Auth: bearer DESIGN_CALENDAR_API_TOKEN.

import { createClient } from "@supabase/supabase-js";
import { authenticateDesignCalendarCaller, rateLimit } from "../_lib/auth.js";
import { unpackGzipEnvelope } from "../_lib/gzipEnvelope.js";

export const config = { maxDuration: 60 };

const MAX_ROWS = 5000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = authenticateDesignCalendarCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const tokenTail = (req.headers.authorization || "").slice(-8) || "anon";
  const rl = rateLimit(`upload-payment-state:${tokenTail}`, { limit: 120, windowMs: 60 * 60 * 1000 });
  if (!rl.ok) return res.status(rl.status).json({ error: rl.error, retry_after_s: rl.retry_after_s });

  const SB_URL = (process.env.VITE_SUPABASE_URL || "").trim();
  const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const body = unpackGzipEnvelope(req.body) || {};
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, MAX_ROWS) : [];
  if (rows.length === 0) return res.status(400).json({ error: "rows: [] required" });

  const now = new Date().toISOString();
  const seen = new Set();
  const upserts = [];
  let skipped = 0;
  for (const r of rows) {
    const num = String(r?.invoice_number || "").trim();
    if (!num || seen.has(num)) { skipped++; continue; }
    seen.add(num);
    const d = String(r.full_payment_date || "").slice(0, 10);
    upserts.push({
      invoice_number: num,
      payment_status: String(r.payment_status || "").slice(0, 60) || null,
      full_payment_date: ISO_DATE_RE.test(d) ? d : null,
      synced_at: now,
    });
  }

  let upserted = 0;
  const errors = [];
  for (let i = 0; i < upserts.length; i += 500) {
    const chunk = upserts.slice(i, i + 500);
    const { error } = await admin
      .from("ar_xoro_payment_state")
      .upsert(chunk, { onConflict: "entity_id,invoice_number", ignoreDuplicates: false });
    if (error) { errors.push(`chunk ${i}: ${error.message}`); continue; }
    upserted += chunk.length;
  }
  return res.status(errors.length ? 207 : 200).json({ received: rows.length, upserted, skipped, errors });
}
