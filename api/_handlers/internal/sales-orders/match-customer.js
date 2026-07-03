// api/internal/sales-orders/match-customer
//
// AI customer matcher for the 🤖 customer-PO upload flow. Given the customer
// NAME the AI parsed off a PO (e.g. "Ross Stores, Inc."), pick the best-matching
// customer in the master — semantically, not just by string overlap, so a buying
// entity like "Ross Procurement" wins over an unrelated name that happens to
// share a word. The operator still confirms the pick in the UI.
//
// POST { name, address? }
//   → { customer_id, customer_name, confidence, reasoning, alternatives:[{id,name}] }
//     customer_id is null when nothing is a credible match (or AI is unavailable).
//
// Claude claude-haiku-4-5-20251001. No-ops gracefully without ANTHROPIC_API_KEY.

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
async function entityId(admin) {
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
}
function parseJson(text) {
  const cleaned = String(text || "").replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  body = body || {};
  const name = String(body.name || "").trim();
  if (!name) return res.status(400).json({ error: "name required" });
  const address = body.address ? String(body.address).trim() : "";

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const eid = await entityId(admin);
  if (!eid) return res.status(500).json({ error: "Default entity (ROF) not found" });

  // The candidate master: every active customer (id + name + code).
  const { data: rows, error } = await admin
    .from("customers")
    .select("id, name, customer_code")
    .eq("entity_id", eid)
    .order("name", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  const customers = rows || [];
  if (!customers.length) return res.status(200).json({ customer_id: null, customer_name: null, confidence: null, reasoning: null, alternatives: [] });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(200).json({ customer_id: null, customer_name: null, confidence: null, reasoning: "AI not configured", alternatives: [] });
  const ai = new Anthropic({ apiKey });

  // Number the candidates so the model returns a stable index → exact id.
  const list = customers.map((c, i) => `${i + 1}. ${c.name}${c.customer_code ? ` [${c.customer_code}]` : ""}`).join("\n");
  const prompt =
    `You match a customer named on a purchase order to the correct account in our customer master.\n` +
    `Think broadly and semantically — a retailer's buying/procurement entity, a parent/subsidiary, a "dba" or legal-vs-trade name, or a common abbreviation should match even when the wording differs (e.g. "Ross Stores, Inc." is the same business as "Ross Procurement"). Do NOT match on an incidental shared word when the businesses are clearly different.\n\n` +
    `PO customer name: "${name}"${address ? `\nPO address: ${address}` : ""}\n\n` +
    `Customer master (pick ONE by its number, or none if there is no credible match):\n${list}\n\n` +
    `Respond with ONLY this JSON (no markdown):\n` +
    `{ "index": <1-based number or null>, "confidence": "high|medium|low", "reasoning": "<one short sentence>", "alternatives": [<up to 2 other plausible numbers>] }`;

  try {
    const msg = await ai.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });
    const parsed = parseJson(msg.content?.[0]?.text) || {};
    const at = (n) => (Number.isInteger(n) && n >= 1 && n <= customers.length ? customers[n - 1] : null);
    const hit = at(parsed.index);
    const alts = Array.isArray(parsed.alternatives)
      ? parsed.alternatives.map(at).filter(Boolean).map((c) => ({ id: c.id, name: c.name }))
      : [];
    return res.status(200).json({
      customer_id: hit?.id || null,
      customer_name: hit?.name || null,
      confidence: parsed.confidence || null,
      reasoning: parsed.reasoning || null,
      alternatives: alts,
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
