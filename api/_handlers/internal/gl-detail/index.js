// api/internal/gl-detail
//
// Tangerine P7-7 — GL Detail by Account × Period (drill from Trial Balance).
//
// GET — return ordered ACCRUAL journal_entry_lines for a single account in a
// date window, with running balance + JE drill ids, via RPC
// gl_detail(p_account_id, p_from, p_to).
//
// Query params:
//   account_id = UUID            (required)
//   from       = YYYY-MM-DD      (required)
//   to         = YYYY-MM-DD      (required)
//   basis      = ACCRUAL | CASH  (optional; default ACCRUAL)
//
// When a basis is supplied the basis-aware gl_detail_b RPC is used so the
// drill-down matches the basis the financial report is showing; ACCRUAL/absent
// stays on the original gl_detail RPC for backwards compatibility.
//
// Response shape:
//   { account_id, from, to, basis, rows: [{ posting_date, je_id, description,
//     debit_cents, credit_cents, running_balance_cents, source_module, source_id }] }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

// P10-8 D9: GL Detail is account-scoped (account_id is a UUID PK, which under
// gl_accounts (entity_id, code) UNIQUE is intrinsically entity-scoped). When
// the request carries X-Entity-ID, verify the account belongs to that entity
// — refuse 403 on mismatch to keep cross-entity drill-ins explicit (a user
// browsing SANDBOX cannot accidentally load ROF's account 1000).
export async function verifyAccountEntity(admin, accountId, req) {
  const hdr = (req.headers?.["x-entity-id"] || req.headers?.["X-Entity-ID"] || "").toString().trim();
  if (!hdr) return { ok: true }; // legacy clients without the header — no enforcement
  const { data: acct } = await admin.from("gl_accounts").select("entity_id").eq("id", accountId).maybeSingle();
  if (!acct) return { ok: false, status: 404, error: "Account not found" };
  if (acct.entity_id !== hdr) {
    return { ok: false, status: 403, error: "Account belongs to a different entity than X-Entity-ID" };
  }
  return { ok: true };
}

export function isUuid(v) {
  return typeof v === "string" && UUID_RE.test(v);
}

export function isISODate(v) {
  if (typeof v !== "string" || !ISO_DATE_RE.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().startsWith(v);
}

export function validateQuery(params) {
  const accountId = (params.get("account_id") || "").trim();
  const fromRaw = (params.get("from") || "").trim();
  const toRaw = (params.get("to") || "").trim();
  const basisRaw = (params.get("basis") || "").trim().toUpperCase();

  if (!accountId)         return { error: "account_id is required (UUID)" };
  if (!isUuid(accountId)) return { error: "account_id must be a UUID" };
  if (!fromRaw)           return { error: "from is required (YYYY-MM-DD)" };
  if (!toRaw)             return { error: "to is required (YYYY-MM-DD)" };
  if (!isISODate(fromRaw)) return { error: "from must be YYYY-MM-DD" };
  if (!isISODate(toRaw))   return { error: "to must be YYYY-MM-DD" };
  if (fromRaw > toRaw)     return { error: "from must be on or before to" };
  if (basisRaw && !VALID_BASIS.has(basisRaw)) {
    return { error: "basis must be ACCRUAL or CASH" };
  }

  return { data: { account_id: accountId, from: fromRaw, to: toRaw, basis: basisRaw || "ACCRUAL" } };
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

  const url = new URL(req.url, `https://${req.headers.host}`);
  const v = validateQuery(url.searchParams);
  if (v.error) return res.status(400).json({ error: v.error });

  // P10-8 D9: refuse cross-entity drill-ins when an X-Entity-ID is asserted.
  const check = await verifyAccountEntity(admin, v.data.account_id, req);
  if (!check.ok) return res.status(check.status).json({ error: check.error });

  try {
    // CASH (or any explicit basis) uses the basis-aware RPC; ACCRUAL stays on
    // the original gl_detail for backwards compatibility.
    const useBasisAware = v.data.basis && v.data.basis !== "ACCRUAL";
    const { data, error } = useBasisAware
      ? await admin.rpc("gl_detail_b", {
          p_account_id: v.data.account_id,
          p_from: v.data.from,
          p_to: v.data.to,
          p_basis: v.data.basis,
        })
      : await admin.rpc("gl_detail", {
          p_account_id: v.data.account_id,
          p_from: v.data.from,
          p_to: v.data.to,
        });
    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({
      account_id: v.data.account_id,
      from: v.data.from,
      to: v.data.to,
      basis: v.data.basis,
      rows: data || [],
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
