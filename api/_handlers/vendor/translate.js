// api/vendor/translate
//
// POST — translate a batch of short UI strings for the vendor portal's runtime
// AI-translation feature (src/vendor/i18n/translateEngine.ts). Returns a
// same-length, same-order array of translations. Backed by Claude Haiku (fast +
// cheap; UI strings are short and high-volume). Authenticated as any vendor —
// the client caches aggressively so steady-state traffic is light.
//
// body: { texts: string[], target: "<lang code>", target_name: "<English name of language>" }
// resp: { translations: string[] }   // translations[i] corresponds to texts[i]

import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { authenticateVendor } from "../../_lib/vendor-auth.js";

export const config = { maxDuration: 60 };

const MAX_TEXTS = 200;
const MAX_TOTAL_CHARS = 24000;

const RESULT_SCHEMA = {
  type: "object",
  properties: { translations: { type: "array", items: { type: "string" } } },
  required: ["translations"],
  additionalProperties: false,
};

function systemPrompt(targetName) {
  return `You are a professional UI localizer for a B2B apparel manufacturing vendor portal (purchase orders, shipments/ASNs, invoices, payments, RFQs, compliance).

Translate each English string in the input array into ${targetName}.

Rules:
- Return a "translations" array with EXACTLY one entry per input string, in the SAME ORDER. Never merge, split, drop, or reorder.
- Translate ONLY natural-language UI text. Leave UNCHANGED (copy verbatim): numbers, dates, money, percentages, units, email addresses, URLs, and product/order codes or SKUs (e.g. "ROF-P000625", "RYB0594").
- Keep brand names and proper nouns (Ring of Fire, company/person names) in their original form.
- Preserve any placeholders/markup exactly (e.g. {name}, %s, :id, leading/trailing punctuation, emoji).
- Match the tone and brevity of UI labels/buttons. Do not add explanations or quotes.
- If a string has no translatable content, return it unchanged.
- Output JSON only, matching the schema.`;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured (Supabase)" });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "Server not configured (ANTHROPIC_API_KEY missing)" });

  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const authRes = await authenticateVendor(admin, req);
  if (!authRes.ok) return res.status(authRes.status || 401).json({ error: authRes.error });
  const { finish } = authRes;
  const send = (code, payload) => { finish?.(code); return res.status(code).json(payload); };

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return send(400, { error: "Invalid JSON" }); } }
  const texts = body?.texts;
  const target = String(body?.target || "").trim();
  const targetName = String(body?.target_name || "").trim();
  if (!Array.isArray(texts) || texts.length === 0) return send(400, { error: "texts (non-empty array) required" });
  if (texts.length > MAX_TEXTS) return send(400, { error: `too many texts (max ${MAX_TEXTS})` });
  if (!texts.every((t) => typeof t === "string")) return send(400, { error: "texts must be strings" });
  if (!target || !targetName) return send(400, { error: "target and target_name required" });
  const total = texts.reduce((s, t) => s + t.length, 0);
  if (total > MAX_TOTAL_CHARS) return send(400, { error: `payload too large (max ${MAX_TOTAL_CHARS} chars)` });

  // English target → identity (the engine never calls this for "en", but be safe).
  if (target === "en") return send(200, { translations: texts });

  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  try {
    const resp = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 8000,
      system: systemPrompt(targetName),
      output_config: { format: { type: "json_schema", schema: RESULT_SCHEMA } },
      messages: [{
        role: "user",
        content: [{ type: "text", text: `Translate these ${texts.length} strings to ${targetName}. Input JSON array:\n${JSON.stringify(texts)}` }],
      }],
    });
    const block = (resp.content || []).find((b) => b.type === "text");
    let out = [];
    try { out = JSON.parse(block?.text || "{}").translations || []; } catch { out = []; }
    // Guarantee same-length, same-order: fall back to the original on any gap.
    const translations = texts.map((src, i) => (typeof out[i] === "string" && out[i].length ? out[i] : src));
    return send(200, { translations });
  } catch (e) {
    if (e instanceof Anthropic.APIError) return send(502, { error: `Anthropic API error (${e.status}): ${e.message}` });
    return send(500, { error: String(e.message || e) });
  }
}
