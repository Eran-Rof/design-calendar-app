// api/internal/pim/styles/:style_id/description/publish
//
// POST ?locale=en-US — flip a description row's publish_status from 'draft'
//                      to 'published' AND stamp published_at = now() +
//                      published_by_user_id from the x-user-id header (if a
//                      UUID is supplied).  No request body required.
//                      Re-publishing an already-published row succeeds
//                      (idempotent: just re-stamps published_at).
//
// Tangerine P8-6 (M42 PIM).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
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

function actorUserIdFromReq(req) {
  const v = req.headers?.["x-user-id"];
  if (typeof v !== "string") return null;
  return UUID_RE.test(v) ? v : null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

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

  const actor = actorUserIdFromReq(req);
  const now = new Date().toISOString();

  // Best-effort SET LOCAL app.current_user_id so any future audit triggers
  // can pick the actor up.  Wrapped in try/catch — if the RPC isn't
  // installed yet, we silently skip and still write published_by_user_id
  // directly.  Spec: "handlers SET LOCAL app.current_user_id ... so the
  // published_by_user_id audit column populates" — but we also write it
  // explicitly below to avoid coupling to that side-channel.
  if (actor) {
    try {
      await admin.rpc("set_app_current_user_id", { user_id: actor });
    } catch { /* RPC may not exist yet — fall through */ }
  }

  const { data, error } = await admin
    .from("product_descriptions")
    .update({
      publish_status: "published",
      published_at: now,
      published_by_user_id: actor,
      updated_at: now,
      updated_by_user_id: actor,
    })
    .eq("style_id", style_id)
    .eq("locale", locale)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) {
    return res.status(404).json({ error: "Description not found for this style + locale" });
  }
  return res.status(200).json(data);
}
