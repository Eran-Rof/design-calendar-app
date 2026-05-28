// api/internal/pim/styles/:style_id/description
//
// GET   ?locale=en-US — return the description row for the style + locale.
//                       404 if no row exists for that locale.  Default locale 'en-US'.
// PATCH ?locale=en-US — upsert a DRAFT.  Body subset of
//                       { short_description, long_description,
//                         bullet_1..bullet_5, seo_title, seo_description }.
//                       publish_status is forced to 'draft' (operator must
//                       call /publish to flip it).  updated_at and
//                       updated_by_user_id are stamped server-side.
//
// Tangerine P8-6 (M42 PIM).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

const TEXT_FIELDS = [
  "short_description",
  "long_description",
  "bullet_1", "bullet_2", "bullet_3", "bullet_4", "bullet_5",
  "seo_title", "seo_description",
];

const FIELD_LIMITS = {
  short_description: 500,
  long_description: 20_000,
  bullet_1: 500, bullet_2: 500, bullet_3: 500, bullet_4: 500, bullet_5: 500,
  seo_title: 200,
  seo_description: 500,
};

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-User-Id");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export function parseLocale(params) {
  const raw = params.get("locale");
  const locale = (raw == null || raw === "") ? "en-US" : String(raw).trim();
  if (!LOCALE_RE.test(locale)) {
    return { error: "locale must look like 'en' or 'en-US'" };
  }
  if (locale.length > 16) return { error: "locale too long" };
  return { data: { locale } };
}

export function validatePatch(body) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Body must be an object" };
  }
  const out = {};
  for (const f of TEXT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body, f)) continue;
    const raw = body[f];
    if (raw == null || raw === "") {
      out[f] = null;
      continue;
    }
    if (typeof raw !== "string") return { error: `${f} must be a string or null` };
    if (raw.length > FIELD_LIMITS[f]) {
      return { error: `${f} must be <= ${FIELD_LIMITS[f]} chars` };
    }
    out[f] = raw;
  }
  if (Object.keys(out).length === 0) return { error: "No fields to update" };
  return { data: out };
}

function actorUserIdFromReq(req) {
  const v = req.headers?.["x-user-id"];
  if (typeof v !== "string") return null;
  return UUID_RE.test(v) ? v : null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const style_id = req.query?.style_id;
  if (!style_id || !UUID_RE.test(style_id)) {
    return res.status(400).json({ error: "Invalid style_id" });
  }

  const url = new URL(req.url, `https://${req.headers.host}`);
  const lc = parseLocale(url.searchParams);
  if (lc.error) return res.status(400).json({ error: lc.error });
  const { locale } = lc.data;

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("product_descriptions")
      .select("*")
      .eq("style_id", style_id)
      .eq("locale", locale)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Description not found for this style + locale" });
    return res.status(200).json(data);
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validatePatch(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    // Need the style's entity_id for the upsert insert path.
    const { data: style, error: sErr } = await admin
      .from("style_master")
      .select("id, entity_id")
      .eq("id", style_id)
      .maybeSingle();
    if (sErr) return res.status(500).json({ error: sErr.message });
    if (!style) return res.status(404).json({ error: "Style not found" });

    const actor = actorUserIdFromReq(req);

    const row = {
      entity_id: style.entity_id,
      style_id,
      locale,
      ...v.data,
      // Saving via PATCH always re-drafts: stamp publish_status='draft'
      // even if the row was previously published (operator must re-publish).
      publish_status: "draft",
      updated_at: new Date().toISOString(),
      updated_by_user_id: actor,
    };

    const { data, error } = await admin
      .from("product_descriptions")
      .upsert(row, { onConflict: "style_id,locale" })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  res.setHeader("Allow", "GET, PATCH");
  return res.status(405).json({ error: "Method not allowed" });
}
