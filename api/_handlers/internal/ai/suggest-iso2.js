// api/internal/ai/suggest-iso2
//
// POST /api/internal/ai/suggest-iso2
// Body: { name }
// Returns: { code } — the ISO 3166-1 alpha-2 country code for the given name.
//
// Used by the Country Master add/edit form "🤖 Suggest" button to derive the
// two-letter ISO code from a typed country name. Mirrors the HTS suggest
// handler shape (Anthropic SDK, empty fallback when key absent).

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

  const name = String((body || {}).name || "").trim();
  if (!name) return res.status(400).json({ error: "name required" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(200).json({ code: "", note: "ANTHROPIC_API_KEY not configured" });
  }

  const client = new Anthropic({ apiKey });

  const prompt = `You are an expert in ISO 3166-1 country codes.

Given the country name below, return its ISO 3166-1 alpha-2 (two-letter) code.
- Match common names, official names, and well-known abbreviations (e.g. "USA" -> "US", "United Kingdom" -> "GB", "South Korea" -> "KR").
- If the name does not clearly correspond to a country, return an empty string.

Country name: ${name}

Respond in this exact JSON format (no markdown, just the JSON):
{ "code": "US" }`;

  try {
    const msg = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 100,
      messages: [{ role: "user", content: prompt }],
    });
    const text = msg.content?.[0]?.text || "{}";
    const cleaned = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(cleaned);
    const code = String(parsed.code || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
    return res.status(200).json({ code });
  } catch (e) {
    return res.status(500).json({ error: e.message, code: "" });
  }
}
