// api/internal/inventory-aging/report
//
// Inventory Aging — best-in-class aged-inventory report. READ-ONLY.
// Ages TRUE FIFO layers (inventory_layers.received_at) as of ANY chosen date
// (?as_of=YYYY-MM-DD), splits on-hand across configurable age buckets, and
// returns carrying cost (interest + storage, ATS constants) + velocity
// (last-sold, days-since-sale, units-sold-90, weeks-of-supply) per grain.
//
// Returns { kpis, rows, bucket_labels, as_of }.
//   kpis — inventory_aging_kpis() single-row rollup (+ per-bucket + dead stock)
//   rows — inventory_aging_report() per-grain aggregate
//
// Query params (all optional):
//   as_of=YYYY-MM-DD          as-of / aged date (default: today)
//   group_by=style|style_color|sku|category|warehouse|vendor  (default style)
//   buckets=30,60,90,180,365  5 ascending day cut-offs → 6 buckets
//   category_id, brand_id, vendor_id, location_id  (uuid filters)
//   gender, style_code, color, size                (text filters)
//   min_age_days              layer-level: only layers ≥ N days old
//   bucket=1..6               layer-level: only layers in that bucket
//   min_value_cents, min_qty  group-level HAVING thresholds
//   slow_days                 group-level: no sale in ≥ N days (incl never-sold)
//   include_zero=1            also include zero-on-hand layers
//   dead_days                 KPI dead-stock cut-off (default = top bucket)
//
// Nothing here mutates inventory. Read-model only.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";

export const config = { maxDuration: 60 };

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GROUPS = new Set(["style", "style_color", "sku", "category", "warehouse", "vendor"]);
const DEFAULT_BUCKETS = [30, 60, 90, 180, 365];

async function resolveEntityId(admin, req) {
  const hdr = (req.headers?.["x-entity-id"] || "").toString().trim();
  if (UUID_RE.test(hdr)) return hdr;
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
}

function uuidOrNull(v) {
  const s = (v || "").toString().trim();
  return UUID_RE.test(s) ? s : null;
}
function textOrNull(v) {
  const s = (v || "").toString().trim();
  return s ? s : null;
}

function parseBuckets(raw) {
  if (!raw) return DEFAULT_BUCKETS;
  const parts = raw.toString().split(",").map((s) => parseInt(s.trim(), 10)).filter((x) => Number.isFinite(x) && x > 0);
  // need exactly 5 ascending cut-offs
  if (parts.length !== 5) return DEFAULT_BUCKETS;
  for (let i = 1; i < 5; i++) if (parts[i] <= parts[i - 1]) return DEFAULT_BUCKETS;
  return parts;
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

  const q = req.query || {};
  try {
    const entityId = await resolveEntityId(admin, req);
    if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

    const asOf = DATE_RE.test((q.as_of || "").toString()) ? q.as_of.toString() : null; // null → RPC CURRENT_DATE
    const groupBy = GROUPS.has((q.group_by || "").toString()) ? q.group_by.toString() : "style";
    const buckets = parseBuckets(q.buckets);
    const bucket = q.bucket != null && /^[1-6]$/.test(q.bucket.toString()) ? parseInt(q.bucket.toString(), 10) : null;
    const minAge = Math.max(0, parseInt((q.min_age_days || "0").toString(), 10) || 0);
    const minValue = Math.max(0, parseInt((q.min_value_cents || "0").toString(), 10) || 0);
    const minQty = Math.max(0, Number((q.min_qty || "0").toString()) || 0);
    const slowDays = q.slow_days != null && /^\d+$/.test(q.slow_days.toString()) ? parseInt(q.slow_days.toString(), 10) : null;
    const includeZero = ["1", "true", "yes"].includes((q.include_zero || "").toString().toLowerCase());
    const deadDays = q.dead_days != null && /^\d+$/.test(q.dead_days.toString()) ? parseInt(q.dead_days.toString(), 10) : buckets[4];

    const common = {
      p_entity_id: entityId,
      p_as_of: asOf,
      p_bucket_days: buckets,
      p_category_id: uuidOrNull(q.category_id),
      p_gender: textOrNull(q.gender),
      p_style_code: textOrNull(q.style_code),
      p_color: textOrNull(q.color),
      p_size: textOrNull(q.size),
      p_brand_id: uuidOrNull(q.brand_id),
      p_vendor_id: uuidOrNull(q.vendor_id),
      p_location_id: uuidOrNull(q.location_id),
      p_min_age_days: minAge,
      p_include_zero: includeZero,
    };

    const [{ data: rows, error: rErr }, { data: kpiArr, error: kErr }] = await Promise.all([
      admin.rpc("inventory_aging_report", {
        ...common,
        p_group_by: groupBy,
        p_bucket: bucket,
        p_min_value_cents: minValue,
        p_min_qty: minQty,
        p_slow_days: slowDays,
      }),
      admin.rpc("inventory_aging_kpis", { ...common, p_dead_days: deadDays }),
    ]);
    if (rErr) throw new Error(`report rpc failed: ${rErr.message}`);
    if (kErr) throw new Error(`kpi rpc failed: ${kErr.message}`);

    return res.status(200).json({
      kpis: (kpiArr || [])[0] || null,
      rows: rows || [],
      bucket_days: buckets,
      as_of: asOf,
      group_by: groupBy,
      dead_days: deadDays,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
