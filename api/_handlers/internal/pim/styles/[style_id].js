// api/internal/pim/styles/:style_id
//
// GET — composite, read-only view of one style with all PIM data merged:
//   * the style_master row itself (minimal cols)
//   * attributes: each product_attributes row joined to the matching
//                 product_attribute_definitions row for label/type/options
//   * descriptions: all product_descriptions rows (one per locale)
//   * images: all product_images rows ordered by sort_order
//             (will be empty until P8-7 ships the upload pipeline)
//
// Convenience endpoint for the PIM admin UI — saves N round-trips.
//
// Tangerine P8-6 (M42 PIM).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IMAGE_BUCKET = "pim-images";
const SIGNED_URL_TTL_S = 3600;

/**
 * Attach signed URLs (thumb/web/print) to each product_images row. The stored
 * storage_path* values are bucket-relative; the UI needs real URLs to render.
 * Best-effort: a path that fails to sign yields null for that derivative
 * rather than failing the whole composite read.
 */
export async function signImageRows(admin, rows) {
  return Promise.all((rows || []).map(async (row) => {
    const paths = {
      thumb: row.storage_path_thumb,
      web: row.storage_path_web,
      print: row.storage_path_print,
    };
    const signed = { thumb: null, web: null, print: null };
    await Promise.all(Object.keys(paths).map(async (k) => {
      if (!paths[k]) return;
      const { data, error } = await admin.storage
        .from(IMAGE_BUCKET)
        .createSignedUrl(paths[k], SIGNED_URL_TTL_S);
      if (!error && data?.signedUrl) signed[k] = data.signedUrl;
    }));
    return { ...row, signed_urls: signed };
  }));
}

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

// Merge an attribute row with its definition. Defs are keyed by
// (entity_id, category_id|null, attribute_key); the style's category drives
// which def applies. If no def exists we still return the attribute, with
// def-side fields null — the UI shows it as an orphan.
export function mergeAttributesWithDefs(attrs, defs, styleCategoryId) {
  const defByKey = new Map();
  for (const d of defs) {
    // Prefer category-scoped def, fall back to entity-wide (category_id null).
    const cur = defByKey.get(d.attribute_key);
    if (!cur) { defByKey.set(d.attribute_key, d); continue; }
    if (cur.category_id == null && d.category_id === styleCategoryId) {
      defByKey.set(d.attribute_key, d);
    }
  }
  return attrs.map((a) => {
    const d = defByKey.get(a.attribute_key) || null;
    return {
      id: a.id,
      attribute_key: a.attribute_key,
      value: a.value,
      updated_at: a.updated_at,
      updated_by_user_id: a.updated_by_user_id,
      definition: d
        ? {
            id: d.id,
            label: d.label,
            value_type: d.value_type,
            options: d.options,
            is_required: d.is_required,
            sort_order: d.sort_order,
            category_id: d.category_id,
          }
        : null,
    };
  });
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const style_id = req.query?.style_id;
  if (!style_id || !UUID_RE.test(style_id)) {
    return res.status(400).json({ error: "Invalid style_id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: style, error: sErr } = await admin
    .from("style_master")
    .select("id, entity_id, style_code, style_name, category_id, gender_code, lifecycle_status, season, design_year, shopify_product_id")
    .eq("id", style_id)
    .maybeSingle();
  if (sErr) return res.status(500).json({ error: sErr.message });
  if (!style) return res.status(404).json({ error: "Style not found" });

  // Parallel fetch the four PIM children.
  const [attrsRes, defsRes, descsRes, imagesRes] = await Promise.all([
    admin
      .from("product_attributes")
      .select("id, attribute_key, value, updated_at, updated_by_user_id")
      .eq("style_id", style_id),
    // Fetch defs for both the style's category AND entity-wide defs (category_id null).
    admin
      .from("product_attribute_definitions")
      .select("id, category_id, attribute_key, label, value_type, options, is_required, sort_order")
      .eq("entity_id", style.entity_id)
      .or(`category_id.is.null,category_id.eq.${style.category_id || "00000000-0000-0000-0000-000000000000"}`),
    admin
      .from("product_descriptions")
      .select("id, locale, short_description, long_description, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5, seo_title, seo_description, publish_status, published_at, published_by_user_id, updated_at, updated_by_user_id")
      .eq("style_id", style_id)
      .order("locale", { ascending: true }),
    admin
      .from("product_images")
      .select("id, image_kind, storage_path, storage_path_thumb, storage_path_web, storage_path_print, alt_text, sort_order, is_primary, mime_type, bytes, width, height, uploaded_by_user_id, created_at")
      .eq("style_id", style_id)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true }),
  ]);

  for (const r of [attrsRes, defsRes, descsRes, imagesRes]) {
    if (r.error) return res.status(500).json({ error: r.error.message });
  }

  // product_images.storage_path* are bucket-relative paths, not URLs. Sign
  // each derivative so the client can render it directly. Without this the UI
  // would use the raw bucket path as an <img src> (resolves to a 404 against
  // the page origin) — which is why no PIM image ever displayed.
  const images = await signImageRows(admin, imagesRes.data || []);

  return res.status(200).json({
    style,
    attributes: mergeAttributesWithDefs(attrsRes.data || [], defsRes.data || [], style.category_id),
    descriptions: descsRes.data || [],
    images,
  });
}
