// api/internal/ar-aging/detail
//
// Drill-through Phase 2 — the open invoices behind one AR-aging bucket cell.
//
// GET /api/internal/ar-aging/detail?bucket=<key>[&as_of=YYYY-MM-DD][&customer_id=<uuid>]
//   bucket    required — current | 1-30 | 31-60 | 61-90 | 91-120 | 120+ | total
//   as_of     optional — mirrors the aging report's two modes: absent = the
//             v_ar_aging "current" semantics (paid < total, aged vs today);
//             present = the ar_aging_as_of RPC semantics (adds posting_date
//             <= as_of; note paid_amount_cents is CURRENT, same as the RPC).
//   customer_id optional — one customer's row, else the whole column.
//
// Buckets replicate the SQL exactly (days past due = as_of - due_date; null
// due_date = current) so the drill list always sums to the report cell.
//
// Returns the COMPLETE list (internal pagination past PostgREST's 1000-row
// cap): { mode, as_of, bucket, count, total_open_cents, rows: [...] }.
// Each row carries accrual_je_id so the UI can jump invoice → JE (Phase 1).

import { createClient } from "@supabase/supabase-js";
import { applyBrandScope } from "../../../_lib/brandContext.js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAGE = 1000;
const PAGE_CAP = 200;   // absolute safety valve (200k rows) — never expected
const MAX_ROWS = 5000;  // rows returned; count/total_open_cents cover EVERYTHING

export const AR_BUCKETS = ["current", "1-30", "31-60", "61-90", "91-120", "120+", "total"];

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
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
}

export function isISODate(v) {
  if (typeof v !== "string" || !ISO_DATE_RE.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().startsWith(v);
}

// Whole days between two YYYY-MM-DD dates (asOf - dueDate), matching the SQL
// `p_as_of_date - due_date` integer subtraction.
export function daysPastDue(asOfISO, dueISO) {
  if (!dueISO) return null;
  const a = Date.parse(asOfISO + "T00:00:00Z");
  const d = Date.parse(dueISO + "T00:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(d)) return null;
  return Math.round((a - d) / 86400000);
}

// AR bucket for a days-past-due value — EXACTLY the v_ar_aging / ar_aging_as_of
// CASE: null-or-<=0 current, 1-30, 31-60, 61-90, 91-120, >120.
export function arBucketFor(days) {
  if (days == null || days <= 0) return "current";
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  if (days <= 120) return "91-120";
  return "120+";
}

export function parseDetailQuery(params) {
  const out = { mode: "current", bucket: null, customer_id: null, ar_account_id: null };

  const bucket = (params.get("bucket") || "").trim();
  if (!AR_BUCKETS.includes(bucket)) {
    return { error: `bucket must be one of: ${AR_BUCKETS.join(", ")}` };
  }
  out.bucket = bucket;

  const asOf = (params.get("as_of") || "").trim();
  if (asOf) {
    if (!isISODate(asOf)) return { error: "as_of must be YYYY-MM-DD" };
    out.mode = "as_of";
    out.as_of = asOf;
  }

  const customerId = (params.get("customer_id") || "").trim();
  if (customerId) {
    if (!UUID_RE.test(customerId)) return { error: "customer_id must be a UUID" };
    out.customer_id = customerId;
  }

  const arAccount = (params.get("ar_account") || "").trim();
  if (arAccount && arAccount !== "all") {
    if (!UUID_RE.test(arAccount)) return { error: "ar_account must be a UUID or 'all'" };
    out.ar_account_id = arAccount;
  }

  return { data: out };
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
  const v = parseDetailQuery(url.searchParams);
  if (v.error) return res.status(400).json({ error: v.error });

  const asOf = v.data.as_of || new Date().toISOString().slice(0, 10);

  try {
    // Page through the OPEN invoice set (server-side filters mirror the aging
    // SQL); bucket assignment happens in JS with the same day math.
    const raw = [];
    for (let off = 0; off < PAGE_CAP * PAGE; off += PAGE) {
      let q = admin
        .from("ar_invoices")
        .select(
          "id, customer_id, invoice_number, invoice_date, posting_date, due_date, " +
          "gl_status, source, total_amount_cents, paid_amount_cents, accrual_je_id, " +
          "customers(name, code)",
        )
        .eq("entity_id", entityId)
        .in("gl_status", ["posted", "posted_historical", "partial_paid", "sent"])
        .order("due_date", { ascending: true, nullsFirst: false })
        .order("invoice_number", { ascending: true })
        .range(off, off + PAGE - 1);
      if (v.data.customer_id) q = q.eq("customer_id", v.data.customer_id);
      if (v.data.ar_account_id) q = q.eq("ar_account_id", v.data.ar_account_id);
      if (v.data.mode === "as_of") q = q.lte("posting_date", v.data.as_of);
      q = applyBrandScope(q, req);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      raw.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }

    const rows = [];
    let totalOpen = 0;
    let matchedCount = 0;
    for (const inv of raw) {
      const open = Number(inv.total_amount_cents || 0) - Number(inv.paid_amount_cents || 0);
      // "current" view mode filters paid < total; as_of mode filters open > 0 —
      // both reduce to open > 0.
      if (open <= 0) continue;
      const days = daysPastDue(asOf, inv.due_date);
      const bucket = arBucketFor(days);
      if (v.data.bucket !== "total" && bucket !== v.data.bucket) continue;
      totalOpen += open;
      matchedCount += 1;
      // Totals/count always cover the WHOLE bucket (they must tie to the report
      // cell); the row list is capped so a 20k-invoice bucket stays renderable.
      if (rows.length >= MAX_ROWS) continue;
      rows.push({
        id: inv.id,
        invoice_number: inv.invoice_number,
        customer_id: inv.customer_id,
        customer_name: inv.customers?.name || null,
        customer_code: inv.customers?.code || null,
        invoice_date: inv.invoice_date,
        posting_date: inv.posting_date,
        due_date: inv.due_date,
        days_past_due: days,
        bucket,
        gl_status: inv.gl_status,
        source: inv.source,
        total_amount_cents: Number(inv.total_amount_cents || 0),
        paid_amount_cents: Number(inv.paid_amount_cents || 0),
        open_cents: open,
        accrual_je_id: inv.accrual_je_id || null,
      });
    }

    return res.status(200).json({
      mode: v.data.mode,
      as_of: v.data.as_of || null,
      bucket: v.data.bucket,
      count: matchedCount,
      total_open_cents: totalOpen,
      truncated: matchedCount > rows.length,
      rows,
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
