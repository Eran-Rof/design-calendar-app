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

  const { fabric_content = "", country_of_origin = "", category = "" } = body || {};
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
- Product Category: ${category || "(not specified)"}

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
