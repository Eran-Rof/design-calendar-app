// api/internal/style-master/cbm-estimate
//
// POST /api/internal/style-master/cbm-estimate
// Body: { product_type, fold_type, unit_weight_lb, pack_qty }
// Returns: { carton_length_in, carton_width_in, carton_height_in, cbm,
//            gross_weight_lb, confidence, note }
//
// Estimates the master carton dimensions for an apparel pack using Claude
// Sonnet (claude-sonnet-4-6). It is an ESTIMATE for freight planning, not an
// exact figure — the Style Master persists it on style_master (carton_cbm_m3 +
// estimate columns). Graceful no-op when ANTHROPIC_API_KEY is not configured.

import Anthropic from "@anthropic-ai/sdk";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }

  const { product_type = "", fold_type = "", unit_weight_lb = "", pack_qty = "" } = body || {};
  if (!product_type && !fold_type) {
    return res.status(400).json({ error: "product_type or fold_type required" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(200).json({ note: "ANTHROPIC_API_KEY not configured" });
  }

  const client = new Anthropic({ apiKey });

  // Domain prompt preserved verbatim from the reference demo — it encodes the
  // apparel packing-density reasoning. Do not paraphrase.
  const prompt = `You are estimating shipping carton dimensions for an apparel master carton shipped from China.

Product type: ${product_type || "(not specified)"}
Fold type: ${fold_type || "(not specified)"}
Unit weight: ${unit_weight_lb || "(not specified)"} lb each
Units per carton: ${pack_qty || "(not specified)"}

Estimate a realistic master carton based on typical apparel packing density. Account for:
- Folded/rolled/hanging volume per unit for this product and fold type
- Poly-bag and tissue overhead
- ~3-5% air gap / wiggle room
- Double-wall corrugated carton walls (~5mm)
- Standard carton aspect ratios (don't return absurd shapes)

Respond ONLY with a JSON object, no preamble, no markdown fences:
{
  "carton_length_in": number,
  "carton_width_in": number,
  "carton_height_in": number,
  "cbm": number,
  "gross_weight_lb": number,
  "confidence": "low" | "medium" | "high",
  "note": "one short sentence on the main assumption"
}

CBM = (L * W * H) / 61023.6 using inches. Round CBM to 4 decimals.`;

  try {
    const msg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    });
    // Join every text content block, strip any ```json / ``` fences, then parse.
    const text = (msg.content || [])
      .filter((b) => b && b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    const cleaned = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(cleaned);
    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(500).json({ error: `Carton estimate failed: ${e.message}` });
  }
}
