// api/internal/pim/styles/:style_id/images/:id
//
// PATCH — update one image's mutable fields:
//          { sort_order?, is_primary?, alt_text?, image_kind? }
//
//        If is_primary=true is requested, any existing primary on the same
//        style is flipped to is_primary=false FIRST (two-step swap, mirrors
//        the upload handler). This sidesteps the
//          EXCLUDE (style_id WITH =) WHERE (is_primary = true)
//        constraint on product_images without needing a SAVEPOINT.
//
// Tangerine P8-7 (arch §6).

import { createClient } from "@supabase/supabase-js";
import { validatePatch, isUuid } from "../../../../../../_lib/pim-images.js";

export const config = { maxDuration: 15 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

/** Read style_id + image id from dispatcher params (path: .../images/:id). */
function getIds(req) {
  // The dispatcher merges both path params into req.query. style_id comes
  // from the parent directory's [style_id] segment; id from [id].js.
  const id = req.query?.id;
  const style_id = req.query?.style_id;
  return { id, style_id };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "PATCH") {
    res.setHeader("Allow", "PATCH");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { id, style_id } = getIds(req);
  if (!isUuid(id))       return res.status(400).json({ error: "Invalid image id" });
  if (!isUuid(style_id)) return res.status(400).json({ error: "Invalid style_id" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // Parse body up front so a 400 lands before any DB read.
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const v = validatePatch(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  // Confirm the image belongs to the style on the URL — defends against
  // stale UI links and prevents PATCH from being used to surveil arbitrary
  // image ids by id alone.
  const { data: existing, error: fetchErr } = await admin
    .from("product_images")
    .select("id, style_id, is_primary")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!existing) return res.status(404).json({ error: "Image not found" });
  if (existing.style_id !== style_id) {
    return res.status(404).json({ error: "Image does not belong to this style" });
  }

  // If flipping to primary, clear any existing primary on this style first.
  // No-op if this row IS the existing primary (covered by the .neq filter).
  if (v.data.is_primary === true) {
    const { error: clrErr } = await admin
      .from("product_images")
      .update({ is_primary: false })
      .eq("style_id", style_id)
      .eq("is_primary", true)
      .neq("id", id);
    if (clrErr) return res.status(500).json({ error: "Could not clear existing primary", details: clrErr.message });
  }

  const { data: updated, error: upErr } = await admin
    .from("product_images")
    .update(v.data)
    .eq("id", id)
    .select()
    .single();
  if (upErr) return res.status(500).json({ error: upErr.message });

  return res.status(200).json(updated);
}
