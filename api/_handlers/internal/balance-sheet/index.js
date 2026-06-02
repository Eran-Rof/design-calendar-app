// api/internal/balance-sheet
//
// Tangerine P5-4 — Balance Sheet GET.
//
// GET /api/internal/balance-sheet
//   ?basis=ACCRUAL|CASH        (required)
//   ?as_of=YYYY-MM-DD          (default = today's date in UTC)
//
// Always calls the balance_sheet_as_of(uuid, text, date) RPC — the view
// v_balance_sheet returns full-history balances and would be wrong for the
// UI's "as-of" semantics. The RPC is STABLE and reads the same source data.
//
// Response:
//   {
//     basis,
//     as_of,
//     rows: [
//       { entity_id, basis, account_type, code, name, balance_cents }, ...
//     ]
//   }
//
// Sort order: assets first, then contra_asset, then liability, then equity,
// then ascending by code within each group. The UI splits by account_type
// into three columns; the column-internal ordering is what matters here.
//
// Per docs/tangerine/P5-close-core-financials-architecture.md §6.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_BASES = ["ACCRUAL", "CASH"];

const ACCOUNT_TYPE_ORDER = {
  asset: 0,
  contra_asset: 1,
  liability: 2,
  equity: 3,
};

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

export function isISODate(v) {
  if (typeof v !== "string" || !ISO_DATE_RE.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().startsWith(v);
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

export function validateQuery(params) {
  const out = {};

  const basis = (params.get("basis") || "").trim();
  if (!basis) {
    return { error: "basis is required (ACCRUAL or CASH)" };
  }
  if (!VALID_BASES.includes(basis)) {
    return { error: "basis must be ACCRUAL or CASH" };
  }
  out.basis = basis;

  const asOf = (params.get("as_of") || "").trim();
  if (asOf) {
    if (!isISODate(asOf)) {
      return { error: "as_of must be YYYY-MM-DD" };
    }
    out.as_of = asOf;
  } else {
    out.as_of = todayUTC();
  }

  return { data: out };
}

function sortRows(rows) {
  return [...rows].sort((a, b) => {
    const ta = ACCOUNT_TYPE_ORDER[a.account_type] ?? 99;
    const tb = ACCOUNT_TYPE_ORDER[b.account_type] ?? 99;
    if (ta !== tb) return ta - tb;
    const ca = String(a.code || "");
    const cb = String(b.code || "");
    if (ca < cb) return -1;
    if (ca > cb) return 1;
    return 0;
  });
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

  try {
    const { data, error } = await admin.rpc("balance_sheet_as_of", {
      p_entity_id: entityId,
      p_basis: v.data.basis,
      p_as_of_date: v.data.as_of,
    });
    if (error) return res.status(500).json({ error: error.message });

    const rows = sortRows(data || []);

    return res.status(200).json({
      basis: v.data.basis,
      as_of: v.data.as_of,
      rows,
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
