// api/internal/cash-flow
//
// GET — return the Cash Flow Statement (indirect method) for the default
// entity over a date range.
//
//   Query params:
//     basis   ACCRUAL | CASH    (required)
//     from    YYYY-MM-DD        (default: Jan 1 of the current calendar year)
//     to      YYYY-MM-DD        (default: today)
//
//   Response shape:
//     {
//       basis: "ACCRUAL" | "CASH",
//       from:  "YYYY-MM-DD",
//       to:    "YYYY-MM-DD",
//       rows: [
//         { section: "operating"|"investing"|"financing"|"_cash_reference",
//           line_item: string,
//           amount_cents: number },
//         ...
//       ]
//     }
//
//   The RPC returns rows in a deliberate order (operating section first,
//   then investing, financing, then two _cash_reference rows for the UI
//   footer reconciliation block). The handler preserves that order.
//
// Tangerine P5-5.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_BASES = new Set(["ACCRUAL", "CASH"]);

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

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function fyStartISO() {
  // Default: Jan 1 of current calendar year (matches the operator's calendar
  // fiscal year — locked decision 4 in the P5 arch doc).
  const y = new Date().getUTCFullYear();
  return `${y}-01-01`;
}

export function validateQuery(params) {
  const out = { basis: null, from: fyStartISO(), to: todayISO() };

  const basisRaw = (params.get("basis") || "").trim();
  if (!basisRaw) {
    return { error: "basis is required (ACCRUAL or CASH)" };
  }
  const basis = basisRaw.toUpperCase();
  if (!VALID_BASES.has(basis)) {
    return { error: "basis must be ACCRUAL or CASH" };
  }
  out.basis = basis;

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

  if (out.to < out.from) {
    return { error: "to must be >= from" };
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

  try {
    const { data, error } = await admin.rpc("cash_flow_indirect", {
      p_entity_id: entityId,
      p_basis: v.data.basis,
      p_from_date: v.data.from,
      p_to_date: v.data.to,
    });
    if (error) return res.status(500).json({ error: error.message });

    // Preserve the RPC's row order — do NOT sort.
    const rows = (data || []).map((r) => ({
      section: r.section,
      line_item: r.line_item,
      amount_cents: Number(r.amount_cents || 0),
    }));

    return res.status(200).json({
      basis: v.data.basis,
      from: v.data.from,
      to: v.data.to,
      rows,
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
