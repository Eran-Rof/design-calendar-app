// api/internal/chargebacks/drill
//
// Chargeback Management (#1744) — AUDIT DRILL. Given one aggregate cell from the
// Dilution tab (a totals card, or a by-customer / by-customer-month / by-month /
// by-reason row cell), return the exact constituent rows that sum to it, so any
// on-screen figure can be traced to the chargebacks behind it — and from each of
// those to its AR invoice and the GL journal entries (via .../:id/origin).
//
// GET /api/internal/chargebacks/drill
//   by       = total | customer | customer_month | month | reason   (required)
//   key      = the group key for `by` (required unless by=total):
//                customer        → customer uuid
//                customer_month  → "<customer uuid>|YYYY-MM"
//                month           → YYYY-MM
//                reason          → reason code | __uncoded__ | __factor_churn__
//   measure  = chargeback | creditback | excluded | net | count | matched |
//              dilution | gross_sales                          (default: net)
//   limit    = max rows returned (default 500, max 1000)
//
// Reconciliation is EXACT: `sum_cents` / `count` are computed over ALL matching
// rows (the resolution mirrors dilution-summary via api/_lib/chargebackMatch.js),
// while `rows` is capped to `limit` (most-recent first) with `truncated` set.
//
//   measure=gross_sales → kind:'invoices' — the AR invoices in the dilution
//     denominator for the group (each opens its source document → its JE).
//   everything else      → kind:'chargebacks' — full worklist-shape rows.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";
import {
  DRILL_FACETS,
  DRILL_MEASURES,
  resolveDrillRow,
  drillRowInGroup,
  drillRowInMeasure,
  drillMeasureCents,
} from "../../../_lib/chargebackMatch.js";

export const config = { maxDuration: 30 };

const ISO_MONTH_RE = /^\d{4}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

// Full worklist-shape select — the drawer renders the same columns the Worklist
// tab does, and each row opens the same detail / origin trace.
const FULL_SELECT =
  "id, report_month, factor_customer_no, customer_name, client_customer, item_num, item_date, cb_date, batch, amount_cents, item_type, reason, reason_code, status, notes, customer_id, matched_ar_invoice_id, match_method, disposition, disposition_reason, owner, disposition_at, reason_code_id, updated_by, updated_at, matched:ar_invoices!matched_ar_invoice_id(id, invoice_number, invoice_date, total_amount_cents, customer_id), reason_ref:chargeback_reason_codes!reason_code_id(code, label, category)";
// Minimal select used only to resolve group membership + reconciling sums.
const RESOLVE_SELECT =
  "id, cb_date, customer_id, report_month, amount_cents, reason, reason_code, reason_code_id, matched:ar_invoices!matched_ar_invoice_id(customer_id)";

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token, X-Entity-ID, X-Auth-User-Id");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

function monthBounds(ym) {
  const [y, m] = ym.split("-").map(Number);
  const start = `${ym}-01`;
  const end = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { start, end };
}

async function fetchAll(admin, table, select, tune) {
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = admin.from(table).select(select).range(from, from + PAGE - 1);
    if (tune) q = tune(q);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

// Order matching resolved rows most-recent first (cb_date desc, nulls last).
function byCbDateDesc(a, b) {
  const ax = a.cb_date || "";
  const bx = b.cb_date || "";
  if (ax === bx) return 0;
  if (!ax) return 1;
  if (!bx) return -1;
  return ax < bx ? 1 : -1;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const p = url.searchParams;

  const by = (p.get("by") || "").trim();
  if (!DRILL_FACETS.includes(by)) {
    return res.status(400).json({ error: `by must be one of ${DRILL_FACETS.join(", ")}` });
  }
  const measure = (p.get("measure") || "net").trim();
  if (!DRILL_MEASURES.includes(measure)) {
    return res.status(400).json({ error: `measure must be one of ${DRILL_MEASURES.join(", ")}` });
  }
  const key = (p.get("key") || "").trim();
  const keyErr = validateKey(by, key);
  if (keyErr) return res.status(400).json({ error: keyErr });

  let limit = parseInt(p.get("limit") || String(DEFAULT_LIMIT), 10);
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  try {
    // Resolve every chargeback to its grouping keys (mirrors dilution-summary).
    const cbs = await fetchAll(admin, "factor_chargebacks", RESOLVE_SELECT);
    const reasonCodes = await fetchAll(admin, "chargeback_reason_codes", "id, code");
    const reasonById = new Map(reasonCodes.map((r) => [r.id, r]));
    const resolved = cbs.map((r) => ({ ...resolveDrillRow(r, reasonById), cb_date: r.cb_date || null }));

    if (measure === "gross_sales") {
      return await grossSalesDrill(admin, res, { by, key, resolved, limit });
    }

    // Constituent rows: in the group AND contributing to the clicked measure.
    const matching = resolved.filter(
      (rr) => drillRowInGroup(rr, by, key) && drillRowInMeasure(rr, measure),
    );
    const count = matching.length;
    const sum_cents = matching.reduce((a, rr) => a + drillMeasureCents(rr, measure), 0);

    // Fetch full rows for only the (capped) most-recent ids, in that order.
    const ordered = matching.slice().sort(byCbDateDesc);
    const keepIds = ordered.slice(0, limit).map((rr) => rr.id);
    const fullById = await fetchFullRows(admin, keepIds);
    const rows = keepIds.map((id) => fullById.get(id)).filter(Boolean);

    return res.status(200).json({
      kind: "chargebacks",
      by, key, measure,
      count,
      sum_cents,
      rows,
      truncated: count > rows.length,
      limit,
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

function validateKey(by, key) {
  if (by === "total") return null;
  if (!key) return "key is required for this facet";
  if (by === "customer" && !UUID_RE.test(key)) return "key must be a customer uuid";
  if (by === "customer_month") {
    const i = key.indexOf("|");
    if (i < 0) return "key must be '<customer uuid>|YYYY-MM'";
    if (!UUID_RE.test(key.slice(0, i))) return "key customer part must be a uuid";
    if (!ISO_MONTH_RE.test(key.slice(i + 1))) return "key month part must be YYYY-MM";
  }
  if (by === "month" && !ISO_MONTH_RE.test(key)) return "key must be YYYY-MM";
  return null;
}

// Fetch full worklist-shape rows for a bounded id set, chunked to keep the
// PostgREST `in.(...)` filter small.
async function fetchFullRows(admin, ids) {
  const out = new Map();
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { data, error } = await admin
      .from("factor_chargebacks")
      .select(FULL_SELECT)
      .in("id", slice);
    if (error) throw new Error(error.message);
    for (const r of data || []) out.set(r.id, r);
  }
  return out;
}

// Resolve the AR invoices that make up the dilution DENOMINATOR for a group.
// Mirrors v_chargeback_gross_sales: entity=ROF, customer_id not null,
// invoice_date not null, summed by customer/month. For by=month/total the
// customer set is the resolved chargeback customers (custIds), matching the
// dilution grossByMonth/grossByCustomer denominators exactly.
async function grossSalesDrill(admin, res, { by, key, resolved, limit }) {
  const custIds = [...new Set(resolved.map((r) => r.cid).filter(Boolean))];

  let customerIds = custIds;
  let month = null;
  if (by === "customer") {
    customerIds = [key];
  } else if (by === "customer_month") {
    const i = key.indexOf("|");
    customerIds = [key.slice(0, i)];
    month = key.slice(i + 1);
  } else if (by === "month") {
    month = key;
  } else if (by === "reason") {
    return res.status(400).json({ error: "gross_sales is not defined for the by=reason facet" });
  }
  if (customerIds.length === 0) {
    return res.status(200).json({ kind: "invoices", by, key, measure: "gross_sales", count: 0, sum_cents: 0, rows: [], truncated: false, limit });
  }

  const { data: entity } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  const entityId = entity?.id || null;

  const tune = (q) => {
    let out = q.not("customer_id", "is", null).not("invoice_date", "is", null).in("customer_id", customerIds);
    if (entityId) out = out.eq("entity_id", entityId);
    if (month) { const { start, end } = monthBounds(month); out = out.gte("invoice_date", start).lt("invoice_date", end); }
    return out;
  };

  const invoices = await fetchAll(
    admin, "ar_invoices",
    "id, invoice_number, invoice_date, total_amount_cents, customer_id",
    tune,
  );
  const count = invoices.length;
  const sum_cents = invoices.reduce((a, r) => a + (Number(r.total_amount_cents) || 0), 0);

  const names = await resolveCustomerNames(admin, [...new Set(invoices.map((r) => r.customer_id).filter(Boolean))]);
  invoices.sort((a, b) => {
    const ax = a.invoice_date || "";
    const bx = b.invoice_date || "";
    return ax === bx ? 0 : ax < bx ? 1 : -1;
  });
  const rows = invoices.slice(0, limit).map((r) => ({
    id: r.id,
    invoice_number: r.invoice_number,
    invoice_date: r.invoice_date,
    total_amount_cents: r.total_amount_cents,
    customer_id: r.customer_id,
    customer_name: r.customer_id ? names.get(r.customer_id) || null : null,
  }));

  return res.status(200).json({
    kind: "invoices",
    by, key, measure: "gross_sales",
    count,
    sum_cents,
    rows,
    truncated: count > rows.length,
    limit,
  });
}

async function resolveCustomerNames(admin, ids) {
  const map = new Map();
  if (!ids.length) return map;
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data } = await admin.from("customers").select("id, name").in("id", ids.slice(i, i + CHUNK));
    for (const c of data || []) map.set(c.id, c.name);
  }
  return map;
}
