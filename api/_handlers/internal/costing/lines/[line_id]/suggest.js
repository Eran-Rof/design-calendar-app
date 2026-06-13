// api/internal/costing/lines/:line_id/suggest
//
// GET → AI "Costing co-pilot" cost/price suggestion for a single costing line.
//
// Gathers everything the operator would look at by hand — the line's existing
// LY / T3 comp (cost, sell price, margin), the read-only avg cost, and the
// real PO purchase history for the style across all vendors — then asks Claude
// to recommend a target cost, a sell price, and the resulting gross margin,
// WITH a plain-English rationale and the signals it leaned on.
//
// The handler NEVER writes to the DB. It returns a suggestion object; the
// frontend shows it in a modal and the operator applies values via the normal
// line PUT. So this is purely advisory and safe to call any time.
//
// Cost mode mirrors the rest of the module (src/costing/lib/completeness.ts):
//   • DDP project (payment_terms_name ~ /DDP/i) → suggest `target_cost`.
//   • FOB / Landed                              → suggest `fob_cost`
//     (duty / freight / insurance are buyer-side and held fixed).
//
// Response: {
//   is_ddp, currency,
//   suggested_target_cost, suggested_fob_cost, suggested_sell_target,
//   suggested_margin_pct, confidence (0..1),
//   rationale, signals: string[],
//   comps_used: { ...the numbers fed to the model },
//   model, generated_at
// }

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../../_lib/auth.js";
import { ppkMultiplier } from "../../../../../_lib/prepack.js";

export const config = { maxDuration: 30 };

// Sonnet 4.6 — strong reasoning for a grounded numeric recommendation; a single
// line is cheap and quality matters more than the Haiku latency edge.
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1500;
const PO_HISTORY_LIMIT = 12; // most recent POs fed to the model

function getLineId(req) {
  if (req.query && req.query.line_id) return req.query.line_id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("lines");
  return idx >= 0 ? parts[idx + 1] : null;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });

  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const lineId = getLineId(req);
  if (!lineId) return res.status(400).json({ error: "Missing line id" });

  // ── 1. Line + parent project ───────────────────────────────────────────
  const { data: line, error: lineErr } = await admin
    .from("costing_lines")
    .select(
      "id, project_id, style_code, description, color, target_qty, " +
      "target_cost, fob_cost, duty_rate, freight, insurance, other_costs, landed_cost, " +
      "sell_target, margin_pct, avg_cost, " +
      "ly_unit_cost, ly_unit_price, ly_margin_pct, t3_unit_cost, t3_unit_price, t3_margin_pct"
    )
    .eq("id", lineId)
    .maybeSingle();
  if (lineErr) return res.status(500).json({ error: lineErr.message });
  if (!line) return res.status(404).json({ error: "Line not found" });

  let project = null;
  if (line.project_id) {
    const { data: proj } = await admin
      .from("costing_projects")
      .select("id, project_name, brand, gender_code, payment_terms_name")
      .eq("id", line.project_id)
      .maybeSingle();
    project = proj || null;
  }
  const isDdp = /DDP/i.test(project?.payment_terms_name || "");

  // ── 2. PO purchase history for the style (all vendors, per-unit) ────────
  const styleCode = (line.style_code || "").trim();
  const poHistory = styleCode ? await fetchPoHistory(admin, styleCode) : [];

  // ── 3. Assemble the grounded comp context ──────────────────────────────
  const comps = {
    style_code: styleCode || null,
    color: line.color || null,
    target_qty: num(line.target_qty),
    avg_cost: r2(num(line.avg_cost)),
    ly_unit_cost: r2(num(line.ly_unit_cost)),
    ly_sell_price: r2(num(line.ly_unit_price)),
    ly_margin_pct: line.ly_margin_pct == null ? null : r2(line.ly_margin_pct * 100),
    t3_unit_cost: r2(num(line.t3_unit_cost)),
    t3_sell_price: r2(num(line.t3_unit_price)),
    t3_margin_pct: line.t3_margin_pct == null ? null : r2(line.t3_margin_pct * 100),
    current_target_cost: r2(num(line.target_cost)),
    current_fob_cost: r2(num(line.fob_cost)),
    current_sell_target: r2(num(line.sell_target)),
    duty_rate: num(line.duty_rate),
    freight: num(line.freight),
    insurance: num(line.insurance),
    other_costs: num(line.other_costs),
    po_history: poHistory.slice(0, PO_HISTORY_LIMIT),
    po_history_count: poHistory.length,
  };

  // Nothing to reason from → tell the caller plainly instead of hallucinating.
  const hasAnySignal =
    comps.avg_cost != null || comps.ly_unit_cost != null || comps.t3_unit_cost != null ||
    comps.ly_sell_price != null || comps.t3_sell_price != null || poHistory.length > 0;
  if (!hasAnySignal) {
    return res.status(200).json({
      is_ddp: isDdp,
      insufficient_data: true,
      suggested_target_cost: null,
      suggested_fob_cost: null,
      suggested_sell_target: null,
      suggested_margin_pct: null,
      confidence: 0,
      rationale:
        "No historical cost, sales, or purchase-order data is available for this style yet, " +
        "so there's nothing reliable to base a suggestion on. Pick a style with sales/PO history, " +
        "or enter the first cost manually.",
      signals: [],
      comps_used: comps,
      model: MODEL,
      generated_at: new Date().toISOString(),
    });
  }

  // ── 4. Prompt + Claude ─────────────────────────────────────────────────
  const prompt = buildPrompt({ line, project, isDdp, comps });
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  let message;
  try {
    message = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system:
        "You are a senior apparel sourcing + costing analyst. You output ONLY a single JSON " +
        "object — no prose, no markdown fences. Ground every number in the data provided; never " +
        "invent costs. If a field can't be supported by the data, return null for it.",
      messages: [{ role: "user", content: prompt }],
    });
  } catch (err) {
    return res.status(502).json({ error: "Claude API error: " + err.message });
  }
  if (message.stop_reason === "max_tokens") {
    return res.status(502).json({ error: "AI response was truncated — try again." });
  }

  let parsed;
  try {
    parsed = parseObject(message.content[0]?.text || "");
  } catch {
    return res.status(502).json({ error: "Claude returned unparseable JSON" });
  }

  // ── 5. Normalise + return (server never writes the line) ───────────────
  const out = {
    is_ddp: isDdp,
    insufficient_data: false,
    suggested_target_cost: isDdp ? r2(num(parsed.suggested_target_cost)) : null,
    suggested_fob_cost: isDdp ? null : r2(num(parsed.suggested_fob_cost)),
    suggested_sell_target: r2(num(parsed.suggested_sell_target)),
    suggested_margin_pct: r2(num(parsed.suggested_margin_pct)),
    confidence: clamp01(num(parsed.confidence)),
    rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
    signals: Array.isArray(parsed.signals) ? parsed.signals.filter((s) => typeof s === "string").slice(0, 8) : [],
    comps_used: comps,
    model: MODEL,
    generated_at: new Date().toISOString(),
  };
  return res.status(200).json(out);
}

// ── PO history (per-unit, PPK-exploded) — condensed from po-history.js ────────
async function fetchPoHistory(admin, styleCode) {
  const safeStyle = styleCode.replace(/[%_]/g, "\\$&");
  const items = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data: page, error } = await admin
      .from("po_line_items")
      .select("po_id, item_number, description, qty_ordered, unit_price")
      .ilike("item_number", `${safeStyle}%`)
      .range(from, from + PAGE - 1);
    if (error || !page || page.length === 0) break;
    items.push(...page);
    if (page.length < PAGE) break;
  }
  if (items.length === 0) return [];

  const poIds = [...new Set(items.map((it) => it.po_id).filter(Boolean))];
  const poByUuid = new Map();
  for (let i = 0; i < poIds.length; i += 200) {
    const { data: pos } = await admin
      .from("tanda_pos")
      .select("uuid_id, po_number, vendor_id, date_expected")
      .in("uuid_id", poIds.slice(i, i + 200));
    (pos || []).forEach((p) => poByUuid.set(p.uuid_id, p));
  }
  const vendorIds = [...new Set([...poByUuid.values()].map((p) => p.vendor_id).filter(Boolean))];
  const vendorName = new Map();
  for (let i = 0; i < vendorIds.length; i += 200) {
    const { data: vs } = await admin.from("vendors").select("id, name").in("id", vendorIds.slice(i, i + 200));
    (vs || []).forEach((v) => vendorName.set(v.id, v.name));
  }

  const byPo = new Map();
  for (const it of items) {
    const po = poByUuid.get(it.po_id);
    if (!po) continue;
    let acc = byPo.get(it.po_id);
    if (!acc) {
      acc = { po_number: po.po_number || null, vendor: po.vendor_id ? vendorName.get(po.vendor_id) || null : null,
        date: po.date_expected || null, qty: 0, priceQtySum: 0, priceQtyWeight: 0 };
      byPo.set(it.po_id, acc);
    }
    const mult = ppkMultiplier(null, null, it.description, null, it.item_number);
    const qty = (typeof it.qty_ordered === "number" ? it.qty_ordered : 0) * mult;
    acc.qty += qty;
    if (typeof it.unit_price === "number" && qty > 0) {
      acc.priceQtySum += (it.unit_price / mult) * qty;
      acc.priceQtyWeight += qty;
    }
  }
  return [...byPo.values()]
    .map((a) => ({
      po_number: a.po_number,
      vendor: a.vendor,
      date: a.date,
      qty: Math.round(a.qty),
      unit_cost: a.priceQtyWeight > 0 ? r2(a.priceQtySum / a.priceQtyWeight) : null,
    }))
    .filter((r) => r.unit_cost != null)
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
}

function clamp01(v) {
  if (v == null) return null;
  return Math.max(0, Math.min(1, v));
}

function parseObject(rawText) {
  let text = (rawText || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) text = fenced[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last <= first) throw new Error("no JSON object found");
  return JSON.parse(text.slice(first, last + 1));
}

function buildPrompt({ line, project, isDdp, comps }) {
  const poLines = comps.po_history.length
    ? comps.po_history
        .map((p) => `  • ${p.date || "?"} — ${p.vendor || "vendor?"} — ${p.qty} units @ $${p.unit_cost}/unit (PO ${p.po_number || "?"})`)
        .join("\n")
    : "  (no purchase-order history for this style)";

  const costField = isDdp ? "suggested_target_cost" : "suggested_fob_cost";
  const costLabel = isDdp ? "DDP target cost (landed, duty-paid)" : "FOB cost (vendor ex-works; duty/freight are buyer-side)";

  return `Recommend the cost + sell price for an apparel style being costed.

## Style
- Style: ${comps.style_code || "(unknown)"}${comps.color ? ` · color ${comps.color}` : ""}
- Description: ${line.description || "(none)"}
- Brand: ${project?.brand || "(none)"} · Gender: ${project?.gender_code || "(none)"}
- Order qty being costed: ${comps.target_qty ?? "(not set)"}
- Cost mode: ${isDdp ? "DDP — quote a landed, duty-paid cost" : "FOB / Landed — quote the vendor's FOB cost only"}

## Historical signals (all per-unit, USD)
- Standard avg cost (book): ${comps.avg_cost ?? "—"}
- Last year (LY): cost ${comps.ly_unit_cost ?? "—"} | sold @ ${comps.ly_sell_price ?? "—"} | margin ${comps.ly_margin_pct ?? "—"}%
- Trailing 3 mo (T3): cost ${comps.t3_unit_cost ?? "—"} | sold @ ${comps.t3_sell_price ?? "—"} | margin ${comps.t3_margin_pct ?? "—"}%
- Current entries on the line: target_cost ${comps.current_target_cost ?? "—"} | fob_cost ${comps.current_fob_cost ?? "—"} | sell_target ${comps.current_sell_target ?? "—"}
${isDdp ? "" : `- Buyer-side adders held fixed: duty_rate ${comps.duty_rate ?? 0} | freight ${comps.freight ?? 0} | insurance ${comps.insurance ?? 0} | other ${comps.other_costs ?? 0}\n`}
## Purchase-order history (most recent first)
${poLines}

## Task
Recommend, grounded ONLY in the numbers above plus apparel sourcing norms:
1. ${costLabel} → "${costField}"
2. A sell price (wholesale) → "suggested_sell_target" — consistent with how this style actually sold (LY/T3) and a healthy gross margin (aim ≥ 20% when the data supports it).
3. The resulting gross margin % = (sell − cost)/sell × 100 → "suggested_margin_pct".

Weight RECENT PO costs and T3 over older LY data. If signals conflict or are thin, lower your confidence and say why.

Return ONLY this JSON object:
{
  "${costField}": <number or null>,
  "suggested_sell_target": <number or null>,
  "suggested_margin_pct": <number or null>,
  "confidence": <0.0-1.0>,
  "signals": ["<short data-grounded observation>", ...],
  "rationale": "<2-3 sentence plain-English explanation an operator can trust>"
}`;
}
