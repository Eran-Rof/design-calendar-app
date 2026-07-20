// api/internal/chargebacks
//
// Chargeback Management module (#1744) — the managed worklist over
// factor_chargebacks. Superset of the read-only Factor-Recon chargeback tab:
// adds the matched AR invoice, the disposition workflow, governed reason codes
// and dilution filters.
//
// GET /api/internal/chargebacks
//   Filters (all optional, AND-combined):
//     disposition = open|valid|disputed|recovered|written_off
//     customer_id = uuid            (factor_chargebacks.customer_id)
//     reason_code_id = uuid | 'none'  ('none' = un-coded)
//     month = YYYY-MM               (report_month)
//     matched = true|false          (has / lacks a matched AR invoice)
//     item_type = chargeback|creditback
//     q = free text on item_num / customer_name
//   Pagination: page (1-based), page_size (default 100, max 500).
//   Sorting: sort in {cb_date,item_date,amount_cents,customer_name,disposition,
//            report_month,item_num,reason,owner}, dir in {asc,desc}.
//   Response: { rows, total, page, page_size, reason_codes }.
//
// Writes go through PATCH /api/internal/chargebacks/:id ([id].js).

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";
import { attachChurnTwins } from "../../../_lib/chargebackChurnTwins.js";

export const config = { maxDuration: 30 };

export const DISPOSITIONS = ["open", "valid", "disputed", "recovered", "written_off"];
const SORTS = ["cb_date", "item_date", "amount_cents", "customer_name", "disposition", "report_month", "item_num", "reason", "owner"];
const ISO_MONTH_RE = /^\d{4}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SELECT =
  "id, report_month, factor_customer_no, customer_name, client_customer, item_num, item_date, cb_date, batch, amount_cents, item_type, reason, reason_code, status, notes, customer_id, matched_ar_invoice_id, match_method, disposition, disposition_reason, owner, disposition_at, reason_code_id, is_factor_churn, churn_kind, churn_pair_id, updated_by, updated_at, matched:ar_invoices!matched_ar_invoice_id(id, invoice_number, invoice_date, total_amount_cents, customer_id), reason_ref:chargeback_reason_codes!reason_code_id(code, label, category)";

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

  const disposition = (p.get("disposition") || "").trim();
  if (disposition && !DISPOSITIONS.includes(disposition)) {
    return res.status(400).json({ error: `disposition must be one of ${DISPOSITIONS.join(", ")}` });
  }
  const customerId = (p.get("customer_id") || "").trim();
  if (customerId && !UUID_RE.test(customerId)) return res.status(400).json({ error: "customer_id must be a uuid" });
  const reasonCodeId = (p.get("reason_code_id") || "").trim();
  if (reasonCodeId && reasonCodeId !== "none" && !UUID_RE.test(reasonCodeId)) {
    return res.status(400).json({ error: "reason_code_id must be a uuid or 'none'" });
  }
  const month = (p.get("month") || "").trim();
  if (month && !ISO_MONTH_RE.test(month)) return res.status(400).json({ error: "month must be YYYY-MM" });
  const matched = (p.get("matched") || "").trim();
  const itemType = (p.get("item_type") || "").trim();
  const q = (p.get("q") || "").trim();

  let sort = (p.get("sort") || "cb_date").trim();
  if (!SORTS.includes(sort)) sort = "cb_date";
  const dir = (p.get("dir") || "desc").trim().toLowerCase() === "asc" ? "asc" : "desc";

  let page = parseInt(p.get("page") || "1", 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  let pageSize = parseInt(p.get("page_size") || "100", 10);
  if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = 100;
  if (pageSize > 500) pageSize = 500;

  const applyFilters = (query) => {
    if (disposition) query = query.eq("disposition", disposition);
    if (customerId) query = query.eq("customer_id", customerId);
    if (reasonCodeId === "none") query = query.is("reason_code_id", null);
    else if (reasonCodeId) query = query.eq("reason_code_id", reasonCodeId);
    if (month) { const { start, end } = monthBounds(month); query = query.gte("report_month", start).lt("report_month", end); }
    if (matched === "true") query = query.not("matched_ar_invoice_id", "is", null);
    else if (matched === "false") query = query.is("matched_ar_invoice_id", null);
    if (itemType) query = query.eq("item_type", itemType);
    if (q) query = query.or(`item_num.ilike.%${q}%,customer_name.ilike.%${q}%`);
    return query;
  };

  try {
    // total count (head request)
    const { count, error: cErr } = await applyFilters(
      admin.from("factor_chargebacks").select("id", { count: "exact", head: true })
    );
    if (cErr) return res.status(500).json({ error: cErr.message });

    const from = (page - 1) * pageSize;
    const { data, error } = await applyFilters(
      admin.from("factor_chargebacks").select(SELECT)
    )
      .order(sort, { ascending: dir === "asc", nullsFirst: false })
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) return res.status(500).json({ error: error.message });

    // Attach the reversing/reversed twin to offset-pair churn rows for labeling.
    await attachChurnTwins(admin, data || []);

    const { data: reasonCodes } = await admin
      .from("chargeback_reason_codes")
      .select("id, code, label, category, sort")
      .eq("active", true)
      .order("sort", { ascending: true });

    return res.status(200).json({
      rows: data || [],
      total: count || 0,
      page,
      page_size: pageSize,
      reason_codes: reasonCodes || [],
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
