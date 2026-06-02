// api/internal/pim/styles/:style_id/images/:id/signed-url
//
// GET — re-issue signed URLs for the 3 derivatives of one image.
//       Optional ?ttl=N (seconds, 60–86400, default 3600). Useful when the
//       operator wants to paste a fresh link into an email or share dialog
//       and the original URL has expired.
//
// Tangerine P8-7 (arch §6).

import { createClient } from "@supabase/supabase-js";
import { isUuid } from "../../../../../../../_lib/pim-images.js";

export const config = { maxDuration: 15 };
const BUCKET = "pim-images";
const DEFAULT_TTL = 3600;
const MIN_TTL = 60;
const MAX_TTL = 86400;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

function getIds(req) {
  return { id: req.query?.id, style_id: req.query?.style_id };
}

/**
 * Clamp an arbitrary ttl query value into the supported window. Anything
 * unparseable falls back to the default 1h.
 */
export function parseTtl(raw, def = DEFAULT_TTL) {
  if (raw == null || raw === "") return def;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return def;
  if (n < MIN_TTL) return MIN_TTL;
  if (n > MAX_TTL) return MAX_TTL;
  return n;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { id, style_id } = getIds(req);
  if (!isUuid(id))       return res.status(400).json({ error: "Invalid image id" });
  if (!isUuid(style_id)) return res.status(400).json({ error: "Invalid style_id" });

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const ttl = parseTtl(url.searchParams.get("ttl"));

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: row, error: fetchErr } = await admin
    .from("product_images")
    .select("id, style_id, storage_path_thumb, storage_path_web, storage_path_print")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!row) return res.status(404).json({ error: "Image not found" });
  if (row.style_id !== style_id) {
    return res.status(404).json({ error: "Image does not belong to this style" });
  }

  const out = { thumb: null, web: null, print: null };
  const tasks = [
    ["thumb", row.storage_path_thumb],
    ["web",   row.storage_path_web],
    ["print", row.storage_path_print],
  ];
  await Promise.all(tasks.map(async ([kind, path]) => {
    if (!path) return;
    const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(path, ttl);
    if (!error && data?.signedUrl) out[kind] = data.signedUrl;
  }));

  return res.status(200).json({ id, ttl_seconds: ttl, signed_urls: out });
}
