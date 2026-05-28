// api/internal/trial-balance
//
// Tangerine P5-2 — Trial Balance read endpoint.
//
// GET — return per-account net debit/credit rolled up across posted JEs
// for the resolved default entity (ROF).
//
// Query params:
//   basis      = ACCRUAL | CASH   (required)
//   from       = YYYY-MM-DD       (optional)
//   to         = YYYY-MM-DD       (optional)
//
//   - If BOTH from AND to are provided, the handler calls the parameterized
//     RPC trial_balance(p_entity_id, p_basis, p_from_date, p_to_date) — date-
//     bounded by posting_date.
//   - If neither is provided, the handler SELECTs from the unparameterized
//     view v_trial_balance (cumulative across all posted JEs ever).
//   - Mixed (one but not both) is rejected as 400.
//
// Response shape:
//   { basis, from, to, rows: [...] }
//
// where each row carries:
//   entity_id, basis, account_id, code, name, account_type, normal_balance,
//   debit_cents, credit_cents, net_debit_cents, net_credit_cents.
//
// Rows are sorted by `code` ASC in the response (matches accounting
// conventions — assets first 1xxx, liabilities 2xxx, equity 3xxx, etc).
//
// Per docs/tangerine/P5-close-core-financials-architecture.md §4.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

export const BASIS_VALUES = ["ACCRUAL", "CASH"];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

export function isISODate(v) {
  if (typeof v !== "string" || !ISO_DATE_RE.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().startsWith(v);
}

/**
 * Validate the query params for the trial balance endpoint.
 *
 * @param {URLSearchParams} params
 * @returns {{ error: string } | { data: { basis: string, from: string|null, to: string|null, mode: "view"|"rpc" } }}
 */
export function validateQuery(params) {
  const basisRaw = (params.get("basis") || "").trim();
  if (!basisRaw) {
    return { error: "basis is required" };
  }
  if (!BASIS_VALUES.includes(basisRaw)) {
    return { error: `basis must be one of ${BASIS_VALUES.join(", ")}` };
  }

  const fromRaw = (params.get("from") || "").trim();
  const toRaw = (params.get("to") || "").trim();

  // Both-or-neither: mixed inputs reject so the UI never accidentally
  // calls the RPC with one date defaulted to NULL on the server side.
  if ((fromRaw && !toRaw) || (!fromRaw && toRaw)) {
    return { error: "from and to must both be provided (or both omitted)" };
  }

  let from = null;
  let to = null;
  let mode = "view";

  if (fromRaw && toRaw) {
    if (!isISODate(fromRaw)) return { error: "from must be YYYY-MM-DD" };
    if (!isISODate(toRaw)) return { error: "to must be YYYY-MM-DD" };
    if (fromRaw > toRaw) return { error: "from must be on or before to" };
    from = fromRaw;
    to = toRaw;
    mode = "rpc";
  }

  return { data: { basis: basisRaw, from, to, mode } };
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
  const v = validateQuery(url.searchParams);
  if (v.error) return res.status(400).json({ error: v.error });

  try {
    let rows;
    if (v.data.mode === "rpc") {
      const { data, error } = await admin.rpc("trial_balance", {
        p_entity_id: entityId,
        p_basis: v.data.basis,
        p_from_date: v.data.from,
        p_to_date: v.data.to,
      });
      if (error) return res.status(500).json({ error: error.message });
      rows = data || [];
    } else {
      const { data, error } = await admin
        .from("v_trial_balance")
        .select("*")
        .eq("entity_id", entityId)
        .eq("basis", v.data.basis);
      if (error) return res.status(500).json({ error: error.message });
      rows = data || [];
    }

    // Sort by account code ASC — accounting convention puts assets (1xxx)
    // first, liabilities (2xxx), equity (3xxx), revenue (4xxx), expense (5xxx+).
    // String compare is safe because COA codes are lex-stable.
    rows.sort((a, b) => {
      const ca = String(a.code ?? "");
      const cb = String(b.code ?? "");
      return ca < cb ? -1 : ca > cb ? 1 : 0;
    });

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
