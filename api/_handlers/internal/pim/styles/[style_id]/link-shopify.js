// POST /api/internal/pim/styles/:style_id/link-shopify
//
// Links (or unlinks) a style to a Shopify product by setting
// style_master.shopify_product_id. The pull-shopify-images endpoint reads
// this to know which product's images to re-host.
//
// Body: { shopify_product_id: string|number|null }
//   - a positive integer (Shopify product id) → link
//   - null / "" → unlink
//
// Tangerine P11-10 (Shopify product mirror + image unification).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-user-id");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

function getStyleId(req) {
  if (req.query?.style_id) return req.query.style_id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const tail = parts.lastIndexOf("link-shopify");
  return tail > 0 ? parts[tail - 1] : null;
}

/** Normalize the inbound id: null/"" → null (unlink); else a digits-only string. */
export function normalizeProductId(raw) {
  if (raw == null || raw === "") return { value: null };
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return { error: "shopify_product_id must be a positive integer or null" };
  return { value: s };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const styleId = getStyleId(req);
  if (!UUID_RE.test(String(styleId || ""))) {
    return res.status(400).json({ error: "Invalid style_id" });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const norm = normalizeProductId(body.shopify_product_id);
  if (norm.error) return res.status(400).json({ error: norm.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: style, error: sErr } = await admin
    .from("style_master")
    .select("id")
    .eq("id", styleId)
    .maybeSingle();
  if (sErr) return res.status(500).json({ error: sErr.message });
  if (!style) return res.status(404).json({ error: "Style not found" });

  const { data: updated, error: uErr } = await admin
    .from("style_master")
    .update({ shopify_product_id: norm.value })
    .eq("id", styleId)
    .select("id, shopify_product_id")
    .single();
  if (uErr) return res.status(500).json({ error: uErr.message });

  return res.status(200).json({
    style_id: updated.id,
    shopify_product_id: updated.shopify_product_id,
    linked: norm.value != null,
  });
}
