// api/internal/hts/backfill
//
// POST — bulk-classify apparel styles' HTS for Bangladesh, China & Madagascar
// (operator #4). Walks style_master by ascending id (keyset cursor), and for
// each style that doesn't yet have a 3-country coo_hts, makes ONE Claude Haiku
// call that returns a single gender-correct HS code plus the duty rate for each
// of the three origin countries. Writes attributes.coo_hts (3 rows, each with
// the flat +10% additional tariff) and mirrors the primary row onto the
// hts_code / duty_rate_pct / additional_tariff_pct columns.
//
// The UI loops this endpoint feeding `after` (the last id of the previous batch)
// until { done: true }. Idempotent: a style that already has all 3 target
// countries is skipped unless force=true. Falls back to a no-op (done:true,
// note) if ANTHROPIC_API_KEY is not configured.

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 60 };

const TARGETS = ["Bangladesh", "China", "Madagascar"];
const ADDITIONAL_TARIFF_PCT = 10; // Trump-administration flat +10%, all countries.

const GENDER_LABELS = {
  M: "Men's", W: "Women's", B: "Boys'", G: "Girls'",
  U: "Unisex", I: "Infants'", T: "Toddlers'", K: "Kids'",
};

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

function has3Targets(attributes) {
  const coo = attributes && attributes.coo_hts;
  if (!Array.isArray(coo)) return false;
  const have = new Set(coo.map((r) => String((r && r.country) || "").toLowerCase()));
  return TARGETS.every((t) => have.has(t.toLowerCase()));
}

function parseJson(text) {
  const cleaned = String(text || "{}").replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
  return JSON.parse(cleaned);
}

async function classifyStyle(ai, { gender, category, fabric }) {
  const prompt = `You are a US Customs HTS classification expert for apparel & textiles (Chapters 50-63).

Classify ONE style and give the duty rate for three origin countries.
- Gender / Wearer: ${gender || "(not specified)"}
- Product Group: ${category || "(not specified)"}
- Fabric content / composition: ${fabric || "(not specified)"}

Gender is decisive: men's/boys' classify under different codes than women's/girls'.
Return the SINGLE best HS code for THIS gender only — never switch genders.
(Treat Unisex as men's/boys' per the usual GRI convention.)

The HS code does NOT change with country — only the duty rate does:
- Bangladesh: Column 1 General (MFN) rate (no preference for most apparel).
- China: Column 1 General (MFN) rate.
- Madagascar: AGOA-eligible — apparel is usually duty-free (0%) under AGOA; use 0
  unless the code is excluded, then the MFN rate.

Respond as EXACT JSON (no markdown):
{
  "code": "6203.42.4011",
  "description": "Men's trousers, cotton, woven",
  "confidence": "high",
  "countries": {
    "Bangladesh": { "duty_rate_pct": 16.6, "reasoning": "Column 1 General" },
    "China":      { "duty_rate_pct": 16.6, "reasoning": "Column 1 General" },
    "Madagascar": { "duty_rate_pct": 0,    "reasoning": "AGOA duty-free" }
  }
}`;
  const msg = await ai.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 500,
    messages: [{ role: "user", content: prompt }],
  });
  return parseJson(msg.content?.[0]?.text || "{}");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const after = body?.after ? String(body.after) : "";
  const limit = Math.min(Math.max(parseInt(body?.limit, 10) || 8, 1), 25);
  const force = body?.force === true;

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(200).json({ done: true, note: "ANTHROPIC_API_KEY not configured", processed: 0, updated: 0 });
  const ai = new Anthropic({ apiKey });

  // Keyset page of apparel styles by ascending id.
  let q = admin
    .from("style_master")
    .select("id, gender_code, group_name, base_fabric_code_id, attributes")
    .eq("is_apparel", true)
    .is("deleted_at", null)
    .order("id", { ascending: true })
    .limit(limit);
  if (after) q = q.gt("id", after);

  const { data: styles, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  const done = !styles || styles.length < limit;
  if (!styles || styles.length === 0) return res.status(200).json({ done: true, processed: 0, updated: 0, lastId: after || null });

  const lastId = styles[styles.length - 1].id;

  // Resolve fabric compositions for this page in one query.
  const fabricIds = [...new Set(styles.map((s) => s.base_fabric_code_id).filter(Boolean))];
  const fabricById = new Map();
  if (fabricIds.length) {
    const { data: fabs } = await admin.from("fabric_codes").select("id, composition_text").in("id", fabricIds);
    for (const f of fabs || []) fabricById.set(f.id, f.composition_text || "");
  }

  const todo = styles.filter((s) => force || !has3Targets(s.attributes));

  const results = await Promise.all(todo.map(async (s) => {
    try {
      const cls = await classifyStyle(ai, {
        gender: GENDER_LABELS[s.gender_code] || s.gender_code || "",
        category: s.group_name || "",
        fabric: fabricById.get(s.base_fabric_code_id) || "",
      });
      if (!cls || !cls.code) return { id: s.id, ok: false };
      const cooRows = TARGETS.map((country) => {
        const c = (cls.countries && cls.countries[country]) || {};
        const duty = c.duty_rate_pct != null && Number.isFinite(Number(c.duty_rate_pct)) ? Number(c.duty_rate_pct) : null;
        return { country, hts_code: String(cls.code), duty_rate_pct: duty, additional_tariff_pct: ADDITIONAL_TARIFF_PCT };
      });
      const attributes = { ...(s.attributes || {}), coo_hts: cooRows };
      const { error: upErr } = await admin
        .from("style_master")
        .update({
          attributes,
          hts_code: cooRows[0].hts_code,
          duty_rate_pct: cooRows[0].duty_rate_pct,
          additional_tariff_pct: ADDITIONAL_TARIFF_PCT,
        })
        .eq("id", s.id);
      return { id: s.id, ok: !upErr, error: upErr?.message };
    } catch (e) {
      return { id: s.id, ok: false, error: e.message };
    }
  }));

  const updated = results.filter((r) => r.ok).length;
  return res.status(200).json({
    done,
    processed: styles.length,
    classified: todo.length,
    updated,
    skipped: styles.length - todo.length,
    lastId,
    errors: results.filter((r) => !r.ok && r.error).slice(0, 3).map((r) => r.error),
  });
}
