// api/internal/style-master/[id]
//
// GET    — fetch a single style_master row with embedded fabric_codes join.
// PATCH  — update mutable fields. Body: any subset of mutable cols (style_code rejected).
// DELETE — soft-delete by setting deleted_at = now().
//
// Tangerine P1 Chunk 7 + Style Master Sweep 2026-05-30 + Fabric FK 2026-05-30 (#13).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

// New canonical six-letter set per operator (#12, 2026-05-30).
const GENDER_VALUES    = ["M", "B", "C", "G", "W", "U"];
const LIFECYCLE_VALUES = ["active", "phased_out", "discontinued", "core"];
const PLANNING_VALUES  = ["core", "seasonal", "fashion"];
const UUID_RE          = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MUTABLE_FIELDS = new Set([
  "style_name", "description", "category_id", "gender_code", "season", "design_year",
  "is_apparel", "launch_date", "lifecycle_status", "planning_class",
  "base_fabric_code_id", "group_name", "category_name", "sub_category_name", "brand_id", "size_scale_id", "rise", "hts_code", "duty_rate_pct", "additional_tariff_pct",
  "unit_weight_kg", "units_per_carton", "carton_cbm_m3",
  "carton_length_in", "carton_width_in", "carton_height_in", "gross_weight_lb",
  "cbm_confidence", "cbm_note", "cbm_inputs", "carton_cbm_override", "attributes", "aliases",
]);

const STYLE_SELECT = "id, style_code, aliases, style_name, description, category_id, gender_code, season, design_year, is_apparel, launch_date, lifecycle_status, planning_class, base_fabric_code_id, base_fabric_legacy, group_name, category_name, sub_category_name, brand_id, size_scale_id, rise, hts_code, duty_rate_pct, additional_tariff_pct, unit_weight_kg, units_per_carton, carton_cbm_m3, carton_length_in, carton_width_in, carton_height_in, gross_weight_lb, cbm_confidence, cbm_note, cbm_inputs, carton_cbm_override, attributes, created_at, updated_at, deleted_at, base_fabric:fabric_codes!style_master_base_fabric_code_id_fkey(id, code, name)";

// Normalize an aliases payload → an ordered, de-duped (case-insensitive) array of
// trimmed UPPERCASE codes (style codes are uppercase-canonical). Drops blanks.
export function normalizeAliases(input) {
  const arr = Array.isArray(input) ? input : [];
  const seen = new Set();
  const out = [];
  for (const a of arr) {
    const s = String(a ?? "").trim().toUpperCase();
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

// Append `code` (an old style_code) to an aliases array, de-duped (case-insensitive),
// uppercase. Never adds a blank. Returns a new array.
export function appendAlias(aliases, code) {
  const merged = normalizeAliases(aliases);
  const c = String(code ?? "").trim().toUpperCase();
  if (c && !merged.includes(c)) merged.push(c);
  return merged;
}

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res, params) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const id = params?.id || req.query?.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("style_master")
      .select(STYLE_SELECT)
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Style not found" });
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

    // ── Style RENAME (renumber) ────────────────────────────────────────────────
    // style_code is NOT a plain mutable field — renaming is a wired operation: the
    // OLD code is captured into `aliases` so string-keyed style-grain lookups still
    // resolve it, and the new code cascades to the catalog. Transactional history
    // (inventory layers, PO/SO lines, wholesale sales) is FK'd by UUID, so it stays
    // attached automatically; sku_code is kept STABLE so SKU-level joins (costing,
    // ATS, Xoro item numbers) survive untouched.
    let renameFrom = null, renameTo = null;
    if (typeof body?.style_code === "string" && body.style_code.trim() !== "") {
      const newCode = body.style_code.trim().toUpperCase();
      const { data: cur } = await admin
        .from("style_master").select("style_code, aliases").eq("id", id).maybeSingle();
      if (!cur) return res.status(404).json({ error: "Style not found" });
      const oldCode = String(cur.style_code || "").trim();
      if (newCode !== oldCode.toUpperCase()) {
        // Reject a collision with another live style.
        const { data: dup } = await admin
          .from("style_master").select("id")
          .ilike("style_code", newCode).is("deleted_at", null).neq("id", id).maybeSingle();
        if (dup) return res.status(409).json({ error: `Style code ${newCode} is already used by another style` });
        renameFrom = oldCode; renameTo = newCode;
        v.data.style_code = newCode;
        // Auto-capture the old code as an alias (merged with any operator edits).
        v.data.aliases = appendAlias(
          Object.prototype.hasOwnProperty.call(v.data, "aliases") ? v.data.aliases : cur.aliases,
          oldCode,
        );
      }
    }

    if (Object.keys(v.data).length === 0) {
      return res.status(400).json({ error: "No mutable fields supplied" });
    }

    // Self-clearing review flag: if this style was flagged for review by an
    // Inventory Planning promotion, editing it = the reviewer is completing
    // the details, so drop attributes.needs_review (and it leaves the Style
    // Master "Needs review" list). Skip when the caller is already sending an
    // explicit attributes value so we don't clobber it.
    if (!Object.prototype.hasOwnProperty.call(v.data, "attributes")) {
      try {
        const { data: cur } = await admin.from("style_master").select("attributes").eq("id", id).maybeSingle();
        const attrs = cur?.attributes && typeof cur.attributes === "object" ? { ...cur.attributes } : null;
        if (attrs && attrs.needs_review) {
          delete attrs.needs_review;
          v.data.attributes = attrs;
        }
      } catch { /* non-fatal — the edit still goes through, flag just lingers */ }
    }

    const { data, error } = await admin
      .from("style_master")
      .update({ ...v.data, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select(STYLE_SELECT)
      .single();
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ error: "Style not found" });
      if (error.code === "23503") {
        return res.status(400).json({ error: "base_fabric_code_id does not reference an existing fabric" });
      }
      if (error.code === "23505") {
        return res.status(409).json({ error: `style_code already exists for this entity` });
      }
      return res.status(500).json({ error: error.message });
    }

    // Cascade a rename to the string-keyed catalog: update the denormalized
    // ip_item_master.style_code (KEEP sku_code stable) and re-key any prepack
    // matrix on the exact old code. Best-effort — the alias captured above is the
    // durable safety net, and all transactional history is UUID-keyed, so a
    // partial cascade never orphans data. Counts are returned for the toast.
    let cascade = null;
    if (renameFrom && renameTo) {
      cascade = { items: 0, matrices: 0 };
      try {
        const { data: items } = await admin
          .from("ip_item_master").update({ style_code: renameTo })
          .eq("style_id", id).ilike("style_code", renameFrom).select("id");
        cascade.items = (items || []).length;
      } catch { /* non-fatal — alias resolves the old code */ }
      try {
        const { data: mats } = await admin
          .from("prepack_matrices").update({ ppk_style_code: renameTo })
          .ilike("ppk_style_code", renameFrom).select("id");
        cascade.matrices = (mats || []).length;
      } catch { /* non-fatal */ }
    }
    return res.status(200).json(cascade ? { ...data, _renamed: { from: renameFrom, to: renameTo, cascade } } : data);
  }

  if (req.method === "DELETE") {
    const { data, error } = await admin
      .from("style_master")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id)
      .is("deleted_at", null)
      .select()
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Style not found or already deleted" });
    return res.status(200).json({ deleted: true, id });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validatePatch(body) {
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (!MUTABLE_FIELDS.has(k)) continue;
    out[k] = v;
  }
  if (out.gender_code != null && out.gender_code !== "" && !GENDER_VALUES.includes(out.gender_code)) {
    return { error: `gender_code must be one of ${GENDER_VALUES.join(", ")}` };
  }
  if (out.lifecycle_status != null && !LIFECYCLE_VALUES.includes(out.lifecycle_status)) {
    return { error: `lifecycle_status must be one of ${LIFECYCLE_VALUES.join(", ")}` };
  }
  if (out.planning_class != null && out.planning_class !== "" && !PLANNING_VALUES.includes(out.planning_class)) {
    return { error: `planning_class must be one of ${PLANNING_VALUES.join(", ")}` };
  }
  if (out.design_year != null && out.design_year !== "") {
    const y = parseInt(out.design_year, 10);
    if (!Number.isFinite(y) || y < 1990 || y > 2100) {
      return { error: "design_year must be between 1990 and 2100" };
    }
    out.design_year = y;
  }
  if (Object.prototype.hasOwnProperty.call(out, "base_fabric_code_id")) {
    if (out.base_fabric_code_id === "" || out.base_fabric_code_id === null) {
      out.base_fabric_code_id = null;
    } else if (!UUID_RE.test(String(out.base_fabric_code_id))) {
      return { error: "base_fabric_code_id must be a uuid (or null to clear)" };
    }
  }
  // Brand FK (Chunk J, item 4) — uuid or null.
  if (Object.prototype.hasOwnProperty.call(out, "brand_id")) {
    if (out.brand_id === "" || out.brand_id === null) {
      out.brand_id = null;
    } else if (!UUID_RE.test(String(out.brand_id))) {
      return { error: "brand_id must be a uuid (or null to clear)" };
    }
  }
  // Size Scale FK — uuid or null.
  if (Object.prototype.hasOwnProperty.call(out, "size_scale_id")) {
    if (out.size_scale_id === "" || out.size_scale_id === null) {
      out.size_scale_id = null;
    } else if (!UUID_RE.test(String(out.size_scale_id))) {
      return { error: "size_scale_id must be a uuid (or null to clear)" };
    }
  }
  // Normalize empty strings to null for nullable text fields.
  for (const k of [
    "style_name", "gender_code", "season", "planning_class",
    "category_id", "group_name", "category_name", "sub_category_name", "rise", "hts_code",
  ]) {
    if (out[k] === "") out[k] = null;
    else if (typeof out[k] === "string" && ["group_name","category_name","sub_category_name","style_name","season","rise","hts_code"].includes(k)) {
      const trimmed = out[k].trim();
      out[k] = trimmed === "" ? null : trimmed;
    }
  }
  // duty_rate_pct — numeric or null (empty string clears it).
  if ("duty_rate_pct" in out) {
    if (out.duty_rate_pct === "" || out.duty_rate_pct == null) out.duty_rate_pct = null;
    else { const n = Number(out.duty_rate_pct); out.duty_rate_pct = Number.isFinite(n) ? n : null; }
  }
  // additional_tariff_pct (Trump-administration flat +10%) — numeric or null.
  if ("additional_tariff_pct" in out) {
    if (out.additional_tariff_pct === "" || out.additional_tariff_pct == null) out.additional_tariff_pct = null;
    else { const n = Number(out.additional_tariff_pct); out.additional_tariff_pct = Number.isFinite(n) ? n : null; }
  }
  // Logistics roll-up fields — non-negative number / positive int, or null.
  for (const k of ["unit_weight_kg", "carton_cbm_m3"]) {
    if (k in out) {
      if (out[k] === "" || out[k] == null) out[k] = null;
      else { const n = Number(out[k]); out[k] = Number.isFinite(n) && n >= 0 ? n : null; }
    }
  }
  if ("units_per_carton" in out) {
    if (out.units_per_carton === "" || out.units_per_carton == null) out.units_per_carton = null;
    else { const n = Math.floor(Number(out.units_per_carton)); out.units_per_carton = Number.isFinite(n) && n > 0 ? n : null; }
  }
  // AI carton-CBM estimate fields.
  for (const k of ["carton_length_in", "carton_width_in", "carton_height_in", "gross_weight_lb"]) {
    if (k in out) {
      if (out[k] === "" || out[k] == null) out[k] = null;
      else { const n = Number(out[k]); out[k] = Number.isFinite(n) && n >= 0 ? n : null; }
    }
  }
  for (const k of ["cbm_confidence", "cbm_note"]) {
    if (k in out) { if (out[k] == null || out[k] === "") out[k] = null; else out[k] = String(out[k]).trim() || null; }
  }
  if ("cbm_inputs" in out) {
    out.cbm_inputs = out.cbm_inputs && typeof out.cbm_inputs === "object" ? out.cbm_inputs : null;
  }
  if ("carton_cbm_override" in out) out.carton_cbm_override = out.carton_cbm_override === true || out.carton_cbm_override === "true";
  // Aliases — array of old style codes (uppercase, de-duped). Renaming a style
  // auto-appends the prior code here (see the PATCH handler); operators may also
  // edit the list directly in Style Master.
  if ("aliases" in out) out.aliases = normalizeAliases(out.aliases);
  return { data: out };
}
