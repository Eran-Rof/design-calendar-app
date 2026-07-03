// api/internal/addresses/postal-suggest
//
// AI postal-code helper for address fields (operator #7 — "add ai long postal
// code for billing & shipping; back-fill where missing").
//
// POST single:  { line1?, city, state, country? }
//   → { postal, confidence, reasoning }   (does NOT write)
//
// POST bulk:    { bulk: true, limit? }
//   → fill the `postal` key on customer billing/shipping addresses + customer
//     locations that have a city + state but no postal yet, in batches; report
//     { updated, remaining, done }. Only fills blanks (never overwrites), so it
//     is safe to run alongside the Xoro address sync.
//
// Uses Claude claude-haiku-4-5-20251001. No-ops gracefully without ANTHROPIC_API_KEY.
// Postal is stored under `postal` (the key the Xoro sync + live data use).

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 60 };

const BATCH = 30;
const MAX_PER_REQUEST = 120;

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
const INTRO =
  "You are a postal-code expert. Given a mailing address, return its postal code. " +
  "For US addresses give the ZIP — the full ZIP+4 (9 digits, formatted NNNNN-NNNN) when the " +
  "street address makes it determinable, otherwise the 5-digit ZIP. For other countries give " +
  "the standard postal/zip code. If a precise code can't be determined from the address, return " +
  "the most likely 5-digit/standard code for that city + state and mark confidence low.";

function addrLine(a) {
  return [a.line1, a.city, a.state, a.country].filter((x) => x && String(x).trim()).join(", ");
}

async function matchBatch(ai, items) {
  const list = items.map((a, i) => `${i + 1}. ${addrLine(a)}`).join("\n");
  const prompt = `${INTRO}\n\nReturn the postal code for each address:\n${list}\n\n` +
    `Respond with ONLY this JSON (no markdown):\n{ "results": [ { "n": 1, "postal": "90210" } ] }`;
  const msg = await ai.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: Math.min(4000, 120 + items.length * 30),
    messages: [{ role: "user", content: prompt }],
  });
  const parsed = parseJson(msg.content?.[0]?.text);
  const out = new Map();
  if (parsed && Array.isArray(parsed.results)) {
    for (const r of parsed.results) {
      const n = Number(r.n);
      if (Number.isInteger(n) && r.postal) out.set(n - 1, String(r.postal).trim());
    }
  }
  return out;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  body = body || {};

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(200).json({ note: "ANTHROPIC_API_KEY not configured", postal: null, updated: 0, remaining: 0, done: true });
  const ai = new Anthropic({ apiKey });

  // ── Single suggestion (no write) ────────────────────────────────────────────
  if (!body.bulk) {
    const city = String(body.city || "").trim();
    if (!city) return res.status(400).json({ error: "city required for a postal suggestion" });
    const prompt = `${INTRO}\n\nAddress: ${addrLine(body)}\n\n` +
      `Respond with ONLY this JSON (no markdown):\n{ "postal": "90210-1234", "confidence": "high|medium|low", "reasoning": "..." }`;
    try {
      const msg = await ai.messages.create({ model: "claude-haiku-4-5-20251001", max_tokens: 200, messages: [{ role: "user", content: prompt }] });
      const parsed = parseJson(msg.content?.[0]?.text) || {};
      return res.status(200).json({ postal: parsed.postal || null, confidence: parsed.confidence || null, reasoning: parsed.reasoning || null });
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ── Bulk back-fill (writes `postal` on rows missing it but having city+state) ─
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const eid = await entityId(admin);
  if (!eid) return res.status(500).json({ error: "Default entity (ROF) not found" });

  // Gather the work units across customers (billing + shipping) + locations.
  const work = []; // { kind, id, col, addr }
  const haveCityState = (a) => a && String(a.city || "").trim() && String(a.state || "").trim() && !String(a.postal || "").trim();

  const { data: custs } = await admin.from("customers")
    .select("id, billing_address, shipping_address").eq("entity_id", eid).is("deleted_at", null);
  for (const c of custs || []) {
    if (haveCityState(c.billing_address)) work.push({ kind: "customer", id: c.id, col: "billing_address", addr: c.billing_address });
    if (haveCityState(c.shipping_address)) work.push({ kind: "customer", id: c.id, col: "shipping_address", addr: c.shipping_address });
  }
  const { data: locs } = await admin.from("customer_locations").select("id, address");
  for (const l of locs || []) {
    if (haveCityState(l.address)) work.push({ kind: "location", id: l.id, col: "address", addr: l.address });
  }

  const remainingBefore = work.length;
  if (remainingBefore === 0) return res.status(200).json({ updated: 0, remaining: 0, done: true });

  const slice = work.slice(0, MAX_PER_REQUEST);
  let updated = 0;
  for (let i = 0; i < slice.length; i += BATCH) {
    const chunk = slice.slice(i, i + BATCH);
    let matches = new Map();
    try { matches = await matchBatch(ai, chunk.map((w) => w.addr)); } catch { matches = new Map(); }
    for (let j = 0; j < chunk.length; j++) {
      const postal = matches.get(j);
      if (!postal) continue;
      const w = chunk[j];
      const table = w.kind === "customer" ? "customers" : "customer_locations";
      // Re-read so we never clobber a postal the concurrent Xoro sync just wrote.
      const { data: cur } = await admin.from(table).select(w.col).eq("id", w.id).maybeSingle();
      const curAddr = cur ? cur[w.col] : null;
      if (curAddr && String(curAddr.postal || "").trim()) continue; // filled meanwhile → skip
      const newAddr = { ...(curAddr || w.addr), postal };
      const { error } = await admin.from(table).update({ [w.col]: newAddr }).eq("id", w.id);
      if (!error) updated += 1;
    }
  }
  return res.status(200).json({ updated, remaining: Math.max(0, remainingBefore - updated), done: remainingBefore - updated <= 0 });
}
