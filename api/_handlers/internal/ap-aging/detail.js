// api/internal/ap-aging/detail
//
// Drill-through Phase 2 — the open vendor bills behind one AP-aging bucket cell.
//
// GET /api/internal/ap-aging/detail?bucket=<key>[&as_of=YYYY-MM-DD][&vendor_id=<uuid>]
//   bucket    required — current | 1-30 | 31-60 | 61-90 | 91+ | total
//   as_of     optional — absent = v_ap_aging_buckets "current" semantics;
//             present = ap_aging_as_of RPC semantics ((posting_date IS NULL OR
//             posting_date <= as_of) AND open > 0; paid is CURRENT, as the RPC).
//   vendor_id optional — one vendor's row, else the whole column.
//
// Source = the shared `invoices` table (invoice_kind vendor_bill /
// expense_report, gl_status = 'posted'), exactly like the aging SQL, so the
// drill list always sums to the report cell. Mirrors ar-aging/detail.js.

import { createClient } from "@supabase/supabase-js";
import { applyBrandScope } from "../../../_lib/brandContext.js";
import { isISODate, daysPastDue } from "../ar-aging/detail.js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 1000;
const PAGE_CAP = 200;   // absolute safety valve (200k rows) — never expected
const MAX_ROWS = 5000;  // rows returned; count/total_open_cents cover EVERYTHING

export const AP_BUCKETS = ["current", "1-30", "31-60", "61-90", "91+", "total"];

// AP bucket for a days-past-due value — EXACTLY the v_ap_aging_buckets /
// ap_aging_as_of CASE: null-or-<=0 current, 1-30, 31-60, 61-90, >90.
export function apBucketFor(days) {
  if (days == null || days <= 0) return "current";
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "91+";
}

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

export function parseDetailQuery(params) {
  const out = { mode: "current", bucket: null, vendor_id: null };

  const bucket = (params.get("bucket") || "").trim();
  if (!AP_BUCKETS.includes(bucket)) {
    return { error: `bucket must be one of: ${AP_BUCKETS.join(", ")}` };
  }
  out.bucket = bucket;

  const asOf = (params.get("as_of") || "").trim();
  if (asOf) {
    if (!isISODate(asOf)) return { error: "as_of must be YYYY-MM-DD" };
    out.mode = "as_of";
    out.as_of = asOf;
  }

  const vendorId = (params.get("vendor_id") || "").trim();
  if (vendorId) {
    if (!UUID_RE.test(vendorId)) return { error: "vendor_id must be a UUID" };
    out.vendor_id = vendorId;
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
    const raw = [];
    for (let off = 0; off < PAGE_CAP * PAGE; off += PAGE) {
      let q = admin
        .from("invoices")
        .select(
          "id, vendor_id, invoice_number, invoice_kind, posting_date, due_date, " +
          "gl_status, source, total_amount_cents, paid_amount_cents, accrual_je_id, " +
          "vendors(name, code)",
        )
        .eq("entity_id", entityId)
        .eq("gl_status", "posted")
        .in("invoice_kind", ["vendor_bill", "expense_report"])
        .order("due_date", { ascending: true, nullsFirst: false })
        .order("invoice_number", { ascending: true })
        .range(off, off + PAGE - 1);
      if (v.data.vendor_id) q = q.eq("vendor_id", v.data.vendor_id);
      // as_of: (posting_date IS NULL OR posting_date <= as_of) — PostgREST .or.
      if (v.data.mode === "as_of") {
        q = q.or(`posting_date.is.null,posting_date.lte.${v.data.as_of}`);
      }
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
      if (open <= 0) continue;
      const days = daysPastDue(asOf, inv.due_date);
      const bucket = apBucketFor(days);
      if (v.data.bucket !== "total" && bucket !== v.data.bucket) continue;
      totalOpen += open;
      matchedCount += 1;
      // Totals/count always cover the WHOLE bucket (they must tie to the report
      // cell); the row list is capped so a huge bucket stays renderable.
      if (rows.length >= MAX_ROWS) continue;
      rows.push({
        id: inv.id,
        invoice_number: inv.invoice_number,
        invoice_kind: inv.invoice_kind,
        vendor_id: inv.vendor_id,
        vendor_name: inv.vendors?.name || null,
        vendor_code: inv.vendors?.code || null,
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
