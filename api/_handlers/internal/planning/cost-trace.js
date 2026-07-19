// api/internal/planning/cost-trace
//
// READ-ONLY diagnostic: explain why a planning SKU/style resolves the unit
// cost it does — built to diagnose blank Unit Cost cells in the wholesale
// planning grid (e.g. style RYB0412PPK).
//
// The grid's unit-cost cascade (src/inventory-planning/services/
// wholesaleForecastService.ts + src/shared/costResolution.ts +
// src/inventory-planning/utils/poCostFallback.ts) resolves a row's cost as:
//   direct avg (ip_item_avg_cost) → sibling avg (same style) →
//   exact-sku open PO → base-color open-PO fallback →
//   style-level open-PO fallback → null.
// A blank cost means EVERY link returned nothing. This endpoint dumps the RAW
// inputs to each link so we can see which one is broken.
//
// Key drop mechanism it surfaces: wholesaleForecastService builds its PO
// cost rows by joining each open PO's sku_id → ip_item_master.sku_code, then
// `.filter(r => r.sku_code)`. An open PO whose sku_id is absent from the loaded
// item-master set gets an empty sku_code and is silently dropped from the
// fallback. `sku_in_item_master` on each open PO flags exactly that.
//
//   GET ?q=<style-or-sku>   (case-insensitive; matched against sku_code AND
//                            style_code via ILIKE '%q%')
//
// Returns { query, item_master[], avg_cost[], open_pos[], summary, notes,
//           schema_notes[] }. NEVER writes.
//
// Auth: internal-token gate (authenticateInternalCaller — x-internal-token or
// Authorization: Bearer <INTERNAL_API_TOKEN>). Supabase admin client, same as
// the sibling planning handlers.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";
import { buildCostTraceSummary } from "../../../_lib/planningCostTrace.js";

export const config = { maxDuration: 30 };

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

const IM_LIMIT = 200;      // ip_item_master rows returned
const PO_LIMIT = 1000;     // open PO rows returned
const AVG_LIMIT = 500;     // avg_cost rows returned
const CHUNK = 100;         // PostgREST .in() URL-length guard

// Sanitise the query to a safe ILIKE / .or() value. PostgREST's .or() parser
// treats commas/parentheses as syntax, so we strip everything except the
// characters that appear in SKU/style codes. Also caps length.
function sanitizeQ(raw) {
  return String(raw || "").trim().replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, 120);
}

// Try a SELECT with the desired column list; on a PostgREST "column does not
// exist" error (42703), fall back to `*` so an unexpected schema drift can't
// 500 the whole diagnostic. Records what happened in schemaNotes. Returns
// { rows, ok }.
async function safeSelect(admin, table, columns, applyFilters, limit, schemaNotes) {
  try {
    let q = admin.from(table).select(columns);
    q = applyFilters(q);
    const { data, error } = await q.limit(limit);
    if (!error) return { rows: data || [], ok: true };
    if (error.code === "42703" || /column .* does not exist/i.test(error.message || "")) {
      schemaNotes.push(`${table}: column mismatch on explicit select (${error.message}); retried with '*'.`);
      let q2 = admin.from(table).select("*");
      q2 = applyFilters(q2);
      const { data: d2, error: e2 } = await q2.limit(limit);
      if (!e2) return { rows: d2 || [], ok: true };
      schemaNotes.push(`${table}: fallback '*' select also failed: ${e2.message}`);
      return { rows: [], ok: false };
    }
    schemaNotes.push(`${table}: query failed: ${error.message}`);
    return { rows: [], ok: false };
  } catch (e) {
    schemaNotes.push(`${table}: unexpected error: ${e?.message || String(e)}`);
    return { rows: [], ok: false };
  }
}

// Chunked .in() fetch (≤100 ids/values per request) with the same defensive
// column fallback as safeSelect. Caps the total rows returned.
async function safeSelectIn(admin, table, columns, col, values, cap, schemaNotes) {
  const out = [];
  let useStar = false;
  for (let i = 0; i < values.length && out.length < cap; i += CHUNK) {
    const slice = values.slice(i, i + CHUNK);
    const sel = useStar ? "*" : columns;
    const { data, error } = await admin.from(table).select(sel).in(col, slice);
    if (error) {
      if (!useStar && (error.code === "42703" || /column .* does not exist/i.test(error.message || ""))) {
        schemaNotes.push(`${table}: column mismatch on explicit select (${error.message}); retried with '*'.`);
        useStar = true;
        i -= CHUNK; // retry this same slice with '*'
        continue;
      }
      schemaNotes.push(`${table}: chunked query failed: ${error.message}`);
      break;
    }
    for (const r of data || []) {
      out.push(r);
      if (out.length >= cap) break;
    }
  }
  return out;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const q = sanitizeQ(req.query?.q);
  if (!q) return res.status(400).json({ error: "Query param `q` (style or sku) is required" });

  const schemaNotes = [];
  const pat = `%${q}%`;

  // ── 1. ip_item_master — rows whose sku_code OR style_code ILIKE %q% ─────────
  const imRes = await safeSelect(
    admin,
    "ip_item_master",
    "id, sku_code, style_code, unit_cost, pack_size, active",
    (query) => query.or(`sku_code.ilike.${pat},style_code.ilike.${pat}`).order("sku_code", { ascending: true }),
    IM_LIMIT,
    schemaNotes,
  );
  const itemMaster = (imRes.rows || []).map((r) => ({
    id: r.id ?? null,
    sku_code: r.sku_code ?? null,
    style_code: r.style_code ?? null,
    unit_cost: r.unit_cost ?? null,
    pack_size: r.pack_size ?? null,
    active: r.active ?? null,
  }));

  const imIds = [...new Set(itemMaster.map((r) => r.id).filter(Boolean))];
  const imSkuCodes = [...new Set(itemMaster.map((r) => r.sku_code).filter(Boolean))];
  const imById = new Map(itemMaster.map((r) => [r.id, r]));

  // ── 2. ip_item_avg_cost — rows for the matched sku_codes ────────────────────
  let avgCost = [];
  if (imSkuCodes.length) {
    const rows = await safeSelectIn(
      admin,
      "ip_item_avg_cost",
      "sku_code, avg_cost, source, updated_at, standard_unit_price",
      "sku_code",
      imSkuCodes,
      AVG_LIMIT,
      schemaNotes,
    );
    avgCost = rows.map((r) => ({
      sku_code: r.sku_code ?? null,
      avg_cost: r.avg_cost ?? null,
      standard_unit_price: r.standard_unit_price ?? null,
      source: r.source ?? null,
      updated_at: r.updated_at ?? null,
    }));
  }

  // ── 3. ip_open_purchase_orders — open POs for the matched item ids ──────────
  // sku_id is a NOT NULL FK → ip_item_master(id); the table has no sku_code /
  // item_number text column, so POs are reachable only via sku_id. We resolve
  // each PO's sku_id back to its item-master row so the operator sees which
  // sku_code/style/pack_size the PO actually sits on, and flag any PO whose
  // sku_id isn't in the matched item-master set (the drop condition).
  let openPos = [];
  if (imIds.length) {
    const rows = await safeSelectIn(
      admin,
      "ip_open_purchase_orders",
      "sku_id, unit_cost, qty_open, qty_ordered, qty_received, expected_date, channel, source, status, po_number, po_line_number, currency",
      "sku_id",
      imIds,
      PO_LIMIT,
      schemaNotes,
    );
    openPos = rows.map((r) => {
      const im = r.sku_id ? imById.get(r.sku_id) : null;
      return {
        sku_id: r.sku_id ?? null,
        resolved_sku_code: im ? im.sku_code : null,
        resolved_style_code: im ? im.style_code : null,
        resolved_pack_size: im ? im.pack_size : null,
        sku_in_item_master: !!(r.sku_id && imById.has(r.sku_id)),
        unit_cost: r.unit_cost ?? null,
        qty_open: r.qty_open ?? null,
        qty_ordered: r.qty_ordered ?? null,
        qty_received: r.qty_received ?? null,
        expected_date: r.expected_date ?? null,
        channel: r.channel ?? null,
        source: r.source ?? null,
        status: r.status ?? null,
        po_number: r.po_number ?? null,
        po_line_number: r.po_line_number ?? null,
        currency: r.currency ?? null,
      };
    });
  }

  // ── 4. summary + notes ──────────────────────────────────────────────────────
  const { summary, notes } = buildCostTraceSummary({ itemMaster, avgCost, openPos });

  return res.status(200).json({
    query: q,
    item_master: itemMaster,
    avg_cost: avgCost,
    open_pos: openPos,
    summary,
    notes,
    schema_notes: schemaNotes,
  });
}
