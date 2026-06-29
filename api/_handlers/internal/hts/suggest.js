// api/internal/hts/suggest
//
// POST /api/internal/hts/suggest
// Body: { fabric_content, country_of_origin, category }
// Returns: { suggestions: [{ code, description, duty_rate_pct, confidence, reasoning }] }
//
// Uses Claude claude-haiku-4-5-20251001 for fast, cheap HTS classification.
// Falls back to an empty list if ANTHROPIC_API_KEY is not set.

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

  const { fabric_content = "", country_of_origin = "", category = "", gender = "" } = body || {};
  if (!fabric_content && !category) {
    return res.status(400).json({ error: "fabric_content or category required" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(200).json({ suggestions: [], note: "ANTHROPIC_API_KEY not configured" });
  }

  const client = new Anthropic({ apiKey });

  const prompt = `You are a US Customs HTS (Harmonized Tariff Schedule) classification expert specializing in apparel and textiles.

Classify the following fabric/product for US customs import:
- Fabric Content / Description: ${fabric_content || "(not specified)"}
- Country of Origin: ${country_of_origin || "(not specified)"}
- Product Category / Group (top, bottom, accessory): ${category || "(not specified)"}
- Gender / Wearer: ${gender || "(not specified)"}

Gender is decisive for apparel HTS: men's/boys' garments classify under different
codes than women's/girls', and babies'/infants' separately again. When a Gender
IS specified, EVERY suggestion you return MUST be the code for THAT gender only —
do NOT return codes for other genders, and do NOT hedge across genders. The three
suggestions should differ by fabric/knit-vs-woven/construction within the SAME
gender, never by switching the wearer. (Treat Unisex as men's/boys' per the usual
GRI convention unless the construction clearly dictates otherwise.) Only when no
Gender is specified may you span genders.

Country of Origin drives the DUTY RATE, not the HTS code. The HTS code itself
does not change with country. When a Country of Origin IS specified, return the
"duty_rate_pct" that actually applies to imports of that code FROM that country:
apply any US trade-preference program the country qualifies for under this HTS —
e.g. USMCA (Mexico / Canada), AGOA (eligible sub-Saharan African countries such
as Madagascar, Lesotho, Kenya, Ethiopia), CAFTA-DR, KORUS, or GSP — which often
reduces the rate to 0%. If no preference applies (e.g. Bangladesh, China,
Vietnam, India for most apparel), use the Column 1 General (MFN) rate. When no
country is specified, use the Column 1 General (MFN) rate. Always state the basis
in "reasoning" (e.g. "AGOA duty-free", "USMCA originating", or "Column 1 General").

Return the top 3 most likely HTS codes with duty rates. Focus on Chapters 50-63 (textiles and apparel).

Respond in this exact JSON format (no markdown, just the JSON):
{
  "suggestions": [
    { "code": "6110.20.2090", "description": "Sweaters, pullovers — cotton, knitted", "duty_rate_pct": 16.5, "confidence": "high", "reasoning": "Cotton knit sweater matches..." },
    { "code": "...", "description": "...", "duty_rate_pct": 0, "confidence": "medium", "reasoning": "..." },
    { "code": "...", "description": "...", "duty_rate_pct": 0, "confidence": "low", "reasoning": "..." }
  ]
}`;

  try {
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    });
    const text = msg.content?.[0]?.text || "{}";
    // Strip markdown fences if present
    const cleaned = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(cleaned);
    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(500).json({ error: e.message, suggestions: [] });
  }
}
