// api/internal/segment-pl
//
// P26 Segment / Dimensional P&L — GET endpoint.
//
// Returns the sales breakdown grouped by Brand × Channel × Store/Warehouse ×
// Gender over a posting-date range, plus the distinct dimension values present
// (so the UI's configurable column-builder knows what's available). The pivot
// into operator-defined columns is composed client-side from `breakdown`.
//
//   GET /api/internal/segment-pl?from=YYYY-MM-DD&to=YYYY-MM-DD
//     from/to optional — default to FY start (Jan 1 of current year) → today.
//     Entity via X-Entity-ID header (P10 switcher); falls back to ROF.
//
//   200 {
//     from, to,
//     breakdown: [{ brand_id, brand_code, brand_name, channel_code, store_key,
//                   gender_code, lines, qty, net_sales, cogs }, ...],
//     dims: { brands:[{id,code,name}], channels:[code], stores:[key], genders:[code] }
//   }
//
// Source: segment_pl_breakdown() RPC over v_sales_dimensional (sub-ledger sales
// history). The Tangerine GL has no posted sales today; this reports the books
// of record (ip_sales_history_*). See docs/tangerine/P26-...architecture.md.

import { createClient } from "@supabase/supabase-js";

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
  const hdr = (req.headers?.["x-entity-id"] || req.headers?.["X-Entity-ID"] || "").toString().trim();
  if (hdr) {
    const { data } = await admin.from("entities").select("id").eq("id", hdr).maybeSingle();
    if (data?.id) return data.id;
  }
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
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
  const todayISO = today.toISOString().slice(0, 10);
  if (!from) from = `${today.getUTCFullYear()}-01-01`;
  if (!to) to = todayISO;
  if (from > to) return res.status(400).json({ error: "from must be on or before to" });

  try {
    const { data, error } = await admin.rpc("segment_pl_breakdown", {
      p_entity_id: entityId,
      p_from_date: from,
      p_to_date: to,
    });
    if (error) return res.status(500).json({ error: error.message });

    const breakdown = (data || []).map((r) => ({
      brand_id: r.brand_id,
      brand_code: r.brand_code,
      brand_name: r.brand_name || "(unbranded)",
      channel_code: r.channel_code,
      store_key: r.store_key,
      gender_code: r.gender_code || "(none)",
      lines: Number(r.lines) || 0,
      qty: Number(r.qty) || 0,
      net_sales: Number(r.net_sales) || 0,
      cogs: r.cogs == null ? null : Number(r.cogs),
    }));

    // Distinct dimension values present in the window — drives the column builder.
    const brandMap = new Map();
    const channels = new Set();
    const stores = new Set();
    const genders = new Set();
    for (const r of breakdown) {
      if (r.brand_id || r.brand_code) {
        brandMap.set(r.brand_id || r.brand_code, { id: r.brand_id, code: r.brand_code, name: r.brand_name });
      }
      if (r.channel_code) channels.add(r.channel_code);
      if (r.store_key) stores.add(r.store_key);
      if (r.gender_code) genders.add(r.gender_code);
    }

    return res.status(200).json({
      from,
      to,
      breakdown,
      dims: {
        brands: Array.from(brandMap.values()),
        channels: Array.from(channels).sort(),
        stores: Array.from(stores).sort(),
        genders: Array.from(genders).sort(),
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
