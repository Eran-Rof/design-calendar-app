// api/internal/costing/lines/:line_id/size-curve
//
// GET → predicted SIZE CURVE (per-size unit split) for the costing line's style,
// learned from the style's own historical wholesale sales by size.
//
// The math is done here (auditable): aggregate ip_sales_history_wholesale qty by
// the SKU's ip_item_master.size over a trailing 24-month window (PPK rows are
// exploded to units), turn it into a percentage mix, and apply that mix to the
// line's target_qty with largest-remainder rounding so the split sums EXACTLY to
// the order quantity. Claude then adds a short narrative + flags sizes whose
// history may be suppressed (e.g. a size that was stocked out), but it never
// invents the numbers.
//
// Costing lines are color-grain (no per-size column), so this is INFORMATIONAL —
// it tells the operator how to break the buy down by size. Nothing is written.
//
// Response: {
//   style_code, color, target_qty, size_scale_label, basis,
//   total_units_analyzed, txn_count, insufficient_data,
//   sizes: [{ size, units, pct, suggested_qty, flag? }],
//   narrative, model, generated_at
// }

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../../_lib/auth.js";
import { ppkMultiplier, baseStyle } from "../../../../../_lib/prepack.js";

export const config = { maxDuration: 30 };

const MODEL = "claude-haiku-4-5"; // narrative only — the numbers come from SQL
const MAX_TOKENS = 700;
const WINDOW_MONTHS = 24;

// Fallback apparel size ordering when the size scale's order isn't available.
const SIZE_ORDER = [
  "XXS", "XS", "S", "SM", "M", "MD", "L", "LG", "XL", "1X", "XXL", "2X", "2XL",
  "3X", "3XL", "4X", "4XL", "5X", "5XL",
  "0", "2", "4", "6", "8", "10", "12", "14", "16", "18", "20",
  "24", "26", "28", "30", "31", "32", "33", "34", "36", "38", "40", "42", "44",
];

function getLineId(req) {
  if (req.query && req.query.line_id) return req.query.line_id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("lines");
  return idx >= 0 ? parts[idx + 1] : null;
}

function subtractMonths(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const lineId = getLineId(req);
  if (!lineId) return res.status(400).json({ error: "Missing line id" });

  // ── 1. Line ────────────────────────────────────────────────────────────
  const { data: line, error: lineErr } = await admin
    .from("costing_lines")
    .select("id, style_code, color, description, target_qty, size_scale_id, size_scale_label")
    .eq("id", lineId)
    .maybeSingle();
  if (lineErr) return res.status(500).json({ error: lineErr.message });
  if (!line) return res.status(404).json({ error: "Line not found" });

  const styleCode = (line.style_code || "").trim();
  const targetQty = typeof line.target_qty === "number" && line.target_qty > 0 ? Math.round(line.target_qty) : null;
  const colorFilter = typeof line.color === "string" && line.color.trim() ? line.color.trim().toLowerCase() : null;

  const empty = (extra = {}) => ({
    style_code: styleCode || null,
    color: line.color || null,
    target_qty: targetQty,
    size_scale_label: line.size_scale_label || null,
    basis: "style",
    total_units_analyzed: 0,
    txn_count: 0,
    insufficient_data: true,
    sizes: [],
    narrative: "",
    model: MODEL,
    generated_at: new Date().toISOString(),
    ...extra,
  });

  if (!styleCode) {
    return res.status(200).json(empty({ narrative: "This line has no style selected yet." }));
  }

  // ── 2. Canonical size order from the size scale (if assigned) ──────────
  let scaleSizes = null;
  if (line.size_scale_id) {
    const { data: scale } = await admin.from("size_scales").select("id, sizes").eq("id", line.size_scale_id).maybeSingle();
    if (scale && Array.isArray(scale.sizes) && scale.sizes.length) {
      scaleSizes = scale.sizes.map((s) => String(s).trim()).filter(Boolean);
    }
  }

  // ── 3. Resolve style → sku_ids (base + PPK), capturing each SKU's size ──
  const base = baseStyle(styleCode).replace(/[%_]/g, "\\$&");
  const masterRows = [];
  {
    let q = admin
      .from("ip_item_master")
      .select("id, style_code, color, size, description")
      .ilike("style_code", `${base}%`)
      .range(0, 9999);
    if (colorFilter) q = q.ilike("color", colorFilter);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    if (data) masterRows.push(...data);
  }
  const skuSize = new Map();   // sku_id → size string
  const skuMeta = new Map();   // sku_id → {color,size,description,style_code} for ppk
  for (const r of masterRows) {
    if (!r.style_code || baseStyle(r.style_code) !== baseStyle(styleCode)) continue;
    skuSize.set(r.id, (r.size || "").trim() || "(no size)");
    skuMeta.set(r.id, { color: r.color, size: r.size, description: r.description, style_code: r.style_code });
  }
  const skuIds = [...skuSize.keys()];
  if (skuIds.length === 0) {
    return res.status(200).json(empty({ narrative: "No SKUs found for this style in the item master." }));
  }

  // ── 4. Aggregate sales qty by size over the trailing window ────────────
  const today = new Date().toISOString().slice(0, 10);
  const from = subtractMonths(today, WINDOW_MONTHS);
  const unitsBySize = new Map();
  let txnCount = 0;
  for (let i = 0; i < skuIds.length; i += 300) {
    const slice = skuIds.slice(i, i + 300);
    const { data: rows, error } = await admin
      .from("ip_sales_history_wholesale")
      .select("sku_id, qty, qty_grain, qty_units")
      .in("sku_id", slice)
      .gte("txn_date", from)
      .lte("txn_date", today)
      .range(0, 99999);
    if (error) return res.status(500).json({ error: error.message });
    for (const r of rows || []) {
      const size = skuSize.get(r.sku_id);
      if (!size) continue;
      const meta = skuMeta.get(r.sku_id);
      const mult = r.qty_grain === "unit"
        ? 1
        : ppkMultiplier(meta?.color ?? null, meta?.size ?? null, meta?.description ?? null, meta?.style_code ?? null, null);
      const units = r.qty_units != null ? Number(r.qty_units) : (Number(r.qty) || 0) * mult;
      if (!(units > 0)) continue;
      unitsBySize.set(size, (unitsBySize.get(size) || 0) + units);
      txnCount += 1;
    }
  }

  const totalUnits = [...unitsBySize.values()].reduce((s, v) => s + v, 0);
  if (totalUnits <= 0) {
    return res.status(200).json(empty({
      narrative: "This style has no wholesale sales in the last 24 months, so there's no history to learn a size curve from.",
    }));
  }

  // ── 5. Order sizes + build the distribution ────────────────────────────
  const presentSizes = [...unitsBySize.keys()];
  const ordered = orderSizes(presentSizes, scaleSizes);
  let sizes = ordered.map((size) => {
    const units = Math.round(unitsBySize.get(size) || 0);
    return { size, units, pct: Math.round((units / totalUnits) * 1000) / 10 };
  });

  // Apply the mix to target_qty with largest-remainder rounding (sums exactly).
  if (targetQty) {
    const raw = sizes.map((s) => ({ ...s, exact: (s.units / totalUnits) * targetQty }));
    const floored = raw.map((s) => ({ ...s, q: Math.floor(s.exact), rem: s.exact - Math.floor(s.exact) }));
    let assigned = floored.reduce((s, x) => s + x.q, 0);
    let leftover = targetQty - assigned;
    floored.sort((a, b) => b.rem - a.rem);
    for (let i = 0; i < floored.length && leftover > 0; i++, leftover--) floored[i].q += 1;
    const qBySize = new Map(floored.map((x) => [x.size, x.q]));
    sizes = sizes.map((s) => ({ ...s, suggested_qty: qBySize.get(s.size) ?? 0 }));
  }

  // ── 6. Narrative (Claude — numbers already fixed above) ────────────────
  let narrative = "";
  let flags = {};
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (ANTHROPIC_KEY) {
    try {
      const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
      const distLine = sizes.map((s) => `${s.size}: ${s.pct}% (${s.units}u)`).join(", ");
      const msg = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: "You output ONLY a single JSON object, no prose or fences.",
        messages: [{
          role: "user",
          content:
            `Apparel size curve for style ${styleCode}${line.color ? ` (${line.color})` : ""}, ` +
            `from ${totalUnits} units sold over 24 months:\n${distLine}\n\n` +
            `Write a 1-2 sentence plain-English read of this size curve for a buyer, and flag any size ` +
            `that looks unusually low and might be stockout-suppressed rather than truly low demand.\n` +
            `Return JSON: { "narrative": "<text>", "flags": { "<size>": "<short reason>" } }`,
        }],
      });
      const txt = (msg.content[0]?.text || "").trim();
      const fenced = txt.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      const body = fenced ? fenced[1] : txt;
      const first = body.indexOf("{"); const last = body.lastIndexOf("}");
      if (first !== -1 && last > first) {
        const parsed = JSON.parse(body.slice(first, last + 1));
        if (typeof parsed.narrative === "string") narrative = parsed.narrative;
        if (parsed.flags && typeof parsed.flags === "object") flags = parsed.flags;
      }
    } catch {
      // Non-fatal — the numeric curve still returns.
    }
  }
  if (Object.keys(flags).length) {
    sizes = sizes.map((s) => (flags[s.size] ? { ...s, flag: String(flags[s.size]) } : s));
  }

  return res.status(200).json({
    style_code: styleCode,
    color: line.color || null,
    target_qty: targetQty,
    size_scale_label: line.size_scale_label || null,
    basis: "style",
    total_units_analyzed: Math.round(totalUnits),
    txn_count: txnCount,
    insufficient_data: false,
    sizes,
    narrative,
    model: MODEL,
    generated_at: new Date().toISOString(),
  });
}

// Order the present sizes: by the assigned size scale's order if we have it,
// else by the canonical apparel order, else alphanumerically. Unknown sizes
// sink to the end in stable input order.
function orderSizes(present, scaleSizes) {
  const idx = new Map();
  const source = (scaleSizes && scaleSizes.length ? scaleSizes : SIZE_ORDER);
  source.forEach((s, i) => idx.set(s.toUpperCase(), i));
  return [...present].sort((a, b) => {
    const ia = idx.has(a.toUpperCase()) ? idx.get(a.toUpperCase()) : Infinity;
    const ib = idx.has(b.toUpperCase()) ? idx.get(b.toUpperCase()) : Infinity;
    if (ia !== ib) return ia - ib;
    return a.localeCompare(b, undefined, { numeric: true });
  });
}
