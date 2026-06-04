// api/internal/income-statement
//
// Tangerine P5-3 / M6 — Income Statement (P&L) GET endpoint.
// Per docs/tangerine/P5-close-core-financials-architecture.md §5.
//
// GET — return per-account income-statement rows for the default entity (ROF)
//        over a posting-date range.
//
//   Query params:
//     basis=ACCRUAL|CASH   (required)
//     from=YYYY-MM-DD       (optional; defaults to FY start = Jan 1 of current year)
//     to=YYYY-MM-DD         (optional; defaults to today)
//
//   Always calls the `income_statement(p_entity_id, p_basis, p_from_date, p_to_date)`
//   RPC — the underlying view `v_income_statement` is not used directly because
//   callers always need a date range and the RPC encapsulates the filter.
//
//   Returns:
//     { basis, from, to, rows: [
//         { entity_id, basis, account_type, code, name, amount_cents }, ...
//       ] }
//   Rows are sorted by code ASC.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_BASIS = new Set(["ACCRUAL", "CASH"]);

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
    .from("entities")
    .select("id")
    .eq("code", "ROF")
    .maybeSingle();
  if (error || !data) return null;
  return data.id;
}

// P10-8 D9: respect X-Entity-ID header (set by the P10-5 switcher); fall back
// to ROF when absent.
export async function resolveReportEntityId(admin, req) {
  const hdr = (req.headers?.["x-entity-id"] || req.headers?.["X-Entity-ID"] || "").toString().trim();
  if (hdr) {
    const { data } = await admin.from("entities").select("id").eq("id", hdr).maybeSingle();
    if (data?.id) return data.id;
  }
  return await resolveDefaultEntityId(admin);
}

// Try to derive the current FY start/today from `gl_periods` so the default
// window aligns with the operator's fiscal calendar. If that table is empty or
// errors, fall back to a hardcoded calendar-year window (Jan 1 → today).
async function deriveDefaultRange(admin, entityId) {
  const today = new Date();
  const todayISO = today.toISOString().slice(0, 10);
  try {
    if (entityId) {
      // Find the period that contains `today` — its FY start is `start_date`'s
      // year, month 1, day 1 (calendar-month periods per locked decision 4).
      const { data, error } = await admin
        .from("gl_periods")
        .select("start_date")
        .eq("entity_id", entityId)
        .lte("start_date", todayISO)
        .gte("end_date", todayISO)
        .maybeSingle();
      if (!error && data?.start_date) {
        const y = String(data.start_date).slice(0, 4);
        return { from: `${y}-01-01`, to: todayISO };
      }
    }
  } catch {
    // fall through to hardcoded default
  }
  const y = today.getUTCFullYear();
  return { from: `${y}-01-01`, to: todayISO };
}

// M50 D: enrich the flat RPC rows with brand metadata so the UI can group a
// brand-rollup parent's child accounts under a header + subtotal and offer a
// per-brand filter. Joins gl_accounts (by code) for brand_id / brand_rollup /
// parent code, and brand_master for the brand's code + name. Adds, per row:
//   brand_id, brand_code, brand_name, parent_code, brand_rollup, is_brand_child
// Non-fatal: on any error the original rows pass through unchanged (the panel
// still renders a flat P&L, just without grouping).
export async function enrichWithBrandMeta(admin, entityId, rows) {
  try {
    const { data: accts } = await admin
      .from("gl_accounts")
      .select("id, code, brand_id, brand_rollup, parent_account_id")
      .eq("entity_id", entityId);
    if (!accts || accts.length === 0) return { rows, brands: [] };

    const idToCode = new Map(accts.map((a) => [a.id, a.code]));
    const byCode = new Map(accts.map((a) => [a.code, a]));

    const { data: brands } = await admin
      .from("brand_master")
      .select("id, code, name, sort_order, is_default")
      .eq("entity_id", entityId)
      .order("sort_order", { ascending: true });
    const brandById = new Map((brands || []).map((b) => [b.id, b]));

    const enriched = rows.map((r) => {
      const a = byCode.get(r.code);
      if (!a) return { ...r, brand_id: null, brand_code: null, brand_name: null, parent_code: null, brand_rollup: false, is_brand_child: false };
      const brand = a.brand_id ? brandById.get(a.brand_id) : null;
      return {
        ...r,
        brand_id: a.brand_id || null,
        brand_code: brand?.code || null,
        brand_name: brand?.name || null,
        parent_code: a.parent_account_id ? (idToCode.get(a.parent_account_id) || null) : null,
        brand_rollup: !!a.brand_rollup,
        is_brand_child: !!(a.brand_id && a.parent_account_id),
      };
    });

    const brandList = (brands || []).map((b) => ({ id: b.id, code: b.code, name: b.name, is_default: !!b.is_default }));
    return { rows: enriched, brands: brandList };
  } catch {
    return { rows, brands: [] };
  }
}

export function isISODate(v) {
  if (typeof v !== "string" || !ISO_DATE_RE.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().startsWith(v);
}

export function validateQuery(params) {
  const basisRaw = (params.get("basis") || "").trim().toUpperCase();
  if (!basisRaw) return { error: "basis is required (ACCRUAL or CASH)" };
  if (!VALID_BASIS.has(basisRaw)) {
    return { error: "basis must be ACCRUAL or CASH" };
  }

  const out = { basis: basisRaw, from: null, to: null };

  const fromRaw = (params.get("from") || "").trim();
  if (fromRaw) {
    if (!isISODate(fromRaw)) return { error: "from must be YYYY-MM-DD" };
    out.from = fromRaw;
  }

  const toRaw = (params.get("to") || "").trim();
  if (toRaw) {
    if (!isISODate(toRaw)) return { error: "to must be YYYY-MM-DD" };
    out.to = toRaw;
  }

  if (out.from && out.to && out.from > out.to) {
    return { error: "from must be on or before to" };
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

  // P10-8 D9: respect X-Entity-ID from the entity switcher; fall back to ROF.
  const entityId = await resolveReportEntityId(admin, req);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const v = validateQuery(url.searchParams);
  if (v.error) return res.status(400).json({ error: v.error });

  let { basis, from, to } = v.data;
  if (!from || !to) {
    const dflt = await deriveDefaultRange(admin, entityId);
    if (!from) from = dflt.from;
    if (!to)   to   = dflt.to;
  }

  try {
    const { data, error } = await admin.rpc("income_statement", {
      p_entity_id: entityId,
      p_basis: basis,
      p_from_date: from,
      p_to_date: to,
    });
    if (error) return res.status(500).json({ error: error.message });

    const sorted = (data || []).slice().sort((a, b) => {
      const ca = (a.code || "");
      const cb = (b.code || "");
      if (ca < cb) return -1;
      if (ca > cb) return 1;
      return 0;
    });

    // M50 D: attach brand metadata + the entity's brand list for the panel's
    // grouping + per-brand filter (no-op shape when no brands configured).
    const { rows, brands } = await enrichWithBrandMeta(admin, entityId, sorted);

    return res.status(200).json({ basis, from, to, rows, brands });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
