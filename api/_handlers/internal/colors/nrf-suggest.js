// api/internal/colors/nrf-suggest
//
// AI matcher for the NRF (National Retail Federation) standard color code — the
// retail-standard 3-digit color-family code (e.g. 001 White, 110 Black, 220
// Brown, 600 Blue…) + its standard family name.
//
// POST single:  { name, hex? }
//   → { nrf_code, nrf_name, confidence, reasoning }     (does NOT write)
//
// POST bulk:    { bulk: true, limit? }
//   → match color_master rows that have no nrf_code yet (this entity), in
//     batches, WRITE nrf_code + nrf_name, and report progress:
//     { updated, remaining, done }   (the UI calls again until done=true)
//
// Uses Claude claude-haiku-4-5-20251001 (fast/cheap). No-ops gracefully when
// ANTHROPIC_API_KEY is unset.

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 60 };

const BATCH = 40;           // colors per AI call
const MAX_PER_REQUEST = 160; // cap a single bulk request (UI loops for the rest)

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
const NRF_INTRO =
  "You are a retail color-standards expert. The NRF (National Retail Federation) " +
  "Standard Color & Size Codes assign every color a 3-digit numeric color code and " +
  "a standard family name (e.g. 001 White, 100 Off White/Natural, 110 Black, 200 " +
  "Beige, 220 Brown, 300 Red, 320 Orange, 400 Pink, 500 Purple, 600 Blue, 660 Teal, " +
  "700 Green, 800 Yellow, 810 Gold, 900 Grey, 970 Multi). Map each given retail " +
  "color name (using the hex when provided) to the single closest NRF 3-digit code " +
  "and its standard family name. Codes are always 3 digits (zero-padded).";

// NRF maps to Color A only: for a two-tone "A/B" name use just the first token.
function colorAName(name) {
  return String(name || "").split("/")[0].trim() || String(name || "").trim();
}

// One AI call for a batch of {name, hex} → [{ name, nrf_code, nrf_name }].
// Matches on Color A (first "/"-token) but echoes the full input name back so
// the caller can key the result to the original row.
async function matchBatch(ai, items) {
  const list = items.map((c, i) => `${i + 1}. "${colorAName(c.name)}"${c.hex ? ` (hex ${c.hex})` : ""}`).join("\n");
  const prompt = `${NRF_INTRO}

Match each of these colors to its NRF code:
${list}

Respond with ONLY this JSON (no markdown):
{ "matches": [ { "name": "<exact input name>", "nrf_code": "110", "nrf_name": "Black" } ] }`;
  const msg = await ai.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: Math.min(4000, 120 + items.length * 40),
    messages: [{ role: "user", content: prompt }],
  });
  const parsed = parseJson(msg.content?.[0]?.text);
  return Array.isArray(parsed?.matches) ? parsed.matches : [];
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  body = body || {};

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(200).json({ note: "ANTHROPIC_API_KEY not configured", nrf_code: null, nrf_name: null, updated: 0, remaining: 0, done: true });
  const ai = new Anthropic({ apiKey });

  // ── Single suggestion (no write) ────────────────────────────────────────────
  if (!body.bulk) {
    const name = String(body.name || "").trim();
    if (!name) return res.status(400).json({ error: "name required" });
    const prompt = `${NRF_INTRO}

Color name: "${name}"${body.hex ? `\nHex: ${body.hex}` : ""}

Respond with ONLY this JSON (no markdown):
{ "nrf_code": "110", "nrf_name": "Black", "confidence": "high", "reasoning": "..." }`;
    try {
      const msg = await ai.messages.create({ model: "claude-haiku-4-5-20251001", max_tokens: 300, messages: [{ role: "user", content: prompt }] });
      const parsed = parseJson(msg.content?.[0]?.text) || {};
      return res.status(200).json({ nrf_code: parsed.nrf_code || null, nrf_name: parsed.nrf_name || null, confidence: parsed.confidence || null, reasoning: parsed.reasoning || null });
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ── Bulk auto-match (writes nrf_code/nrf_name for rows missing it) ───────────
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const eid = await entityId(admin);
  if (!eid) return res.status(500).json({ error: "Default entity (ROF) not found" });

  // Total still missing (for progress) + this request's working slice.
  const { count: remainingBefore } = await admin.from("color_master")
    .select("id", { count: "exact", head: true }).eq("entity_id", eid).is("nrf_code", null);
  const { data: todo, error } = await admin.from("color_master")
    .select("id, name, hex").eq("entity_id", eid).is("nrf_code", null)
    .order("name", { ascending: true }).limit(MAX_PER_REQUEST);
  if (error) return res.status(500).json({ error: error.message });
  const colors = todo || [];
  if (colors.length === 0) return res.status(200).json({ updated: 0, remaining: 0, done: true });

  let updated = 0;
  for (let i = 0; i < colors.length; i += BATCH) {
    const slice = colors.slice(i, i + BATCH);
    let matches = [];
    try { matches = await matchBatch(ai, slice); } catch { matches = []; }
    const byLower = new Map(matches.filter((m) => m && m.name).map((m) => [String(m.name).toLowerCase().trim(), m]));
    for (const c of slice) {
      const m = byLower.get(colorAName(c.name).toLowerCase().trim());
      const code = m?.nrf_code ? String(m.nrf_code).trim() : null;
      if (!code) continue;
      const { error: uErr } = await admin.from("color_master")
        .update({ nrf_code: code, nrf_name: m.nrf_name ? String(m.nrf_name).trim() : null })
        .eq("id", c.id);
      if (!uErr) updated += 1;
    }
  }
  const remaining = Math.max(0, (remainingBefore || 0) - updated);
  return res.status(200).json({ updated, remaining, done: remaining === 0 });
}
