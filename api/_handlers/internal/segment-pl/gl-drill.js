// api/internal/segment-pl/gl-drill
//
// Drill-through Phase 2 — map one Segment P&L cell to the GL accounts behind it.
//
// GET /api/internal/segment-pl/gl-drill?from&to&measure=net_sales|cogs
//        [&brands=A,B][&channels=..][&stores=..][&genders=..]
//
// The Segment P&L is a pivot over the sales sub-ledger (v_sales_dimensional);
// the GL carries the SAME sales as routed daily bridge JEs (revenue accounts
// 4005-4012 per api/_lib/accounting/revenueRouting.js). This endpoint:
//
//   1. pulls the dims breakdown one grain finer than the panel (adds is_pl —
//      style_code ~* 'PL$', the same private-label test the bridge routes by)
//      via the segment_pl_gl_drill RPC,
//   2. filters it by the cell's column filters (comma lists; empty = all —
//      IDENTICAL match semantics to InternalSegmentPL's matches()),
//   3. maps every remaining group through resolveRevenueRouting → the revenue
//      (or COGS-twin) account code the bridge posts it to, and
//   4. returns per-account: the cell's sub-ledger dollars vs the account's GL
//      posted net over the same window (gl_range_activity_by_code RPC, cents),
//      plus `shared` = other segments also route into this account (so an
//      exact cell-to-GL tie is only expected on unshared accounts).
//
// The UI lists the accounts and jumps each into the existing GLDetailModal
// (account × range × ACCRUAL) → JE → source doc (Phase 1 chain).

import { createClient } from "@supabase/supabase-js";
import { resolveRevenueRouting } from "../../../_lib/accounting/revenueRouting.js";

export const config = { maxDuration: 30 };

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

function isISODate(v) {
  if (typeof v !== "string" || !ISO_DATE_RE.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().startsWith(v);
}

async function resolveEntityId(admin, req) {
  const hdr = (req.headers?.["x-entity-id"] || "").toString().trim();
  if (hdr) {
    const { data } = await admin.from("entities").select("id").eq("id", hdr).maybeSingle();
    if (data?.id) return data.id;
  }
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
}

function parseList(params, name) {
  const raw = (params.get(name) || "").trim();
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

// v_sales_dimensional dims → the resolver's normalized channel. Ecom is
// store-scoped (mirrors the bridge: psychotuna.com wins over item brand).
export function channelFromDims(channelCode, storeKey) {
  if (String(channelCode || "").toUpperCase() !== "DTC") return "wholesale";
  return String(storeKey || "") === "PT Ecom" ? "ecom_pt" : "ecom_rof";
}

// Same column-filter semantics as InternalSegmentPL's matches(): empty = all.
export function rowMatches(r, f) {
  if (f.brands.length && !f.brands.includes(r.brand_code || "")) return false;
  if (f.channels.length && !f.channels.includes(r.channel_code)) return false;
  if (f.stores.length && !f.stores.includes(r.store_key)) return false;
  if (f.genders.length && !f.genders.includes(r.gender_code || "(none)")) return false;
  return true;
}

// Pure core: dims rows + cell filters + measure → per-account sub-ledger sums
// and the set of codes OTHER rows (outside the cell) also route into.
export function mapCellToAccounts(rows, filters, measure) {
  const inCell = new Map();   // code → sub-ledger dollars
  const outside = new Set();  // codes receiving sales from non-matching rows
  let subledgerTotal = 0;
  let cogsUnknown = false;

  for (const r of rows || []) {
    const { revenueCode, cogsCode } = resolveRevenueRouting({
      brandCode: r.brand_code,
      genderCode: r.gender_code,
      channel: channelFromDims(r.channel_code, r.store_key),
      isPrivateLabel: !!r.is_pl,
    });
    const code = measure === "cogs" ? cogsCode : revenueCode;
    if (!code) continue;
    const amount = measure === "cogs" ? (r.cogs == null ? null : Number(r.cogs)) : Number(r.net_sales || 0);

    if (rowMatches(r, filters)) {
      if (amount == null) { cogsUnknown = true; continue; }
      inCell.set(code, (inCell.get(code) || 0) + amount);
      subledgerTotal += amount;
    } else {
      outside.add(code);
    }
  }

  const accounts = [...inCell.entries()]
    .map(([code, amount]) => ({ code, subledger_amount: Math.round(amount * 100) / 100, shared: outside.has(code) }))
    .sort((a, b) => a.code.localeCompare(b.code));
  return { accounts, subledger_total: Math.round(subledgerTotal * 100) / 100, cogs_unknown: cogsUnknown };
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

  const entityId = await resolveEntityId(admin, req);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  let from = (url.searchParams.get("from") || "").trim();
  let to = (url.searchParams.get("to") || "").trim();
  if (from && !isISODate(from)) return res.status(400).json({ error: "from must be YYYY-MM-DD" });
  if (to && !isISODate(to)) return res.status(400).json({ error: "to must be YYYY-MM-DD" });
  const today = new Date();
  if (!from) from = `${today.getUTCFullYear()}-01-01`;
  if (!to) to = today.toISOString().slice(0, 10);
  if (from > to) return res.status(400).json({ error: "from must be on or before to" });

  const measure = (url.searchParams.get("measure") || "net_sales").trim();
  if (!["net_sales", "cogs"].includes(measure)) {
    return res.status(400).json({ error: "measure must be net_sales or cogs" });
  }

  const filters = {
    brands: parseList(url.searchParams, "brands"),
    channels: parseList(url.searchParams, "channels"),
    stores: parseList(url.searchParams, "stores"),
    genders: parseList(url.searchParams, "genders"),
  };

  try {
    const { data: dims, error: dimsErr } = await admin.rpc("segment_pl_gl_drill", {
      p_entity_id: entityId,
      p_from_date: from,
      p_to_date: to,
    });
    if (dimsErr) return res.status(500).json({ error: dimsErr.message });

    const core = mapCellToAccounts(dims || [], filters, measure);

    let accounts = [];
    if (core.accounts.length) {
      const { data: gl, error: glErr } = await admin.rpc("gl_range_activity_by_code", {
        p_entity_id: entityId,
        p_basis: "ACCRUAL",
        p_from_date: from,
        p_to_date: to,
        p_codes: core.accounts.map((a) => a.code),
      });
      if (glErr) return res.status(500).json({ error: glErr.message });
      const glByCode = new Map((gl || []).map((g) => [g.code, g]));
      accounts = core.accounts.map((a) => {
        const g = glByCode.get(a.code);
        const debit = Number(g?.debit_cents || 0);
        const credit = Number(g?.credit_cents || 0);
        // Revenue accounts carry credit-normal balances; COGS (expense) debit-normal.
        const net = measure === "cogs" ? debit - credit : credit - debit;
        return {
          account_id: g?.account_id || null,
          code: a.code,
          name: g?.name || null,
          account_type: g?.account_type || null,
          subledger_amount: a.subledger_amount,
          gl_debit_cents: debit,
          gl_credit_cents: credit,
          gl_net_cents: net,
          shared: a.shared,
        };
      });
    }

    return res.status(200).json({
      from,
      to,
      measure,
      filters,
      subledger_total: core.subledger_total,
      cogs_unknown: core.cogs_unknown,
      gl_total_cents: accounts.reduce((s, a) => s + a.gl_net_cents, 0),
      accounts,
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
