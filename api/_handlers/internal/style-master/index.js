// api/internal/style-master
//
// GET  — list all style_master rows for the default entity. Returns soft-active
//        rows by default; ?include_deleted=true returns everything.
//        Query params: ?q=<search> matches style_code/style_name/description and
//        the joined fabric_codes.code / fabric_codes.name; ?limit=N (default 200).
//        Each row carries an embedded `base_fabric` {id, code, name} from
//        fabric_codes when base_fabric_code_id is set.
// POST — create a new style. Body: { style_code, description, category_id?,
//        gender_code?, season?, design_year?, is_apparel?, planning_class?,
//        lifecycle_status?, base_fabric_code_id?, group_name?, category_name?,
//        sub_category_name?, attributes? }
//
// Tangerine P1 Chunk 7 + Style Master Sweep 2026-05-30 + Fabric FK 2026-05-30 (#13).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

// New canonical six-letter set per operator (#12, 2026-05-30).
// M=Mens, B=Boys, C=Child, G=Girls, W=Womens, U=Unisex.
const GENDER_VALUES     = ["M", "B", "C", "G", "W", "U"];
const LIFECYCLE_VALUES  = ["active", "phased_out", "discontinued", "core"];
const PLANNING_VALUES   = ["core", "seasonal", "fashion"];
const UUID_RE           = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `base_fabric:fabric_codes!style_master_base_fabric_code_id_fkey(...)` joins
// fabric_codes via the explicit FK added in 20260630010000_style_master_base_fabric_fk.sql.
const STYLE_SELECT = "id, style_code, aliases, style_name, description, category_id, gender_code, season, design_year, is_apparel, launch_date, lifecycle_status, planning_class, base_fabric_code_id, base_fabric_legacy, group_name, category_name, sub_category_name, brand_id, size_scale_id, rise, hts_code, duty_rate_pct, additional_tariff_pct, unit_weight_kg, units_per_carton, carton_cbm_m3, carton_length_in, carton_width_in, carton_height_in, gross_weight_lb, cbm_confidence, cbm_note, cbm_inputs, carton_cbm_override, attributes, created_at, updated_at, deleted_at, base_fabric:fabric_codes!style_master_base_fabric_code_id_fkey(id, code, name)";

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function resolveDefaultEntityId(admin) {
  const { data, error } = await admin
    .from("entities")
    .select("id")
    .eq("code", "ROF")
    .maybeSingle();
  if (error || !data) return null;
  return data.id;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const includeDeleted = url.searchParams.get("include_deleted") === "true";
    const q = (url.searchParams.get("q") || "").trim();
    // Default + cap raised 2026-05-30 — operator reported "most styles missing"
    // because the previous 200/500 cap silently truncated the list. This is an
    // internal admin tool with a small entity-scoped table; 10k is well above
    // any plausible style count and still fits one Vercel response.
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "5000", 10) || 5000, 10000);

    // Fresh base query each page. Search covers the three classifier columns
    // too (Polish 2026-05-30) so "Tops"/"T-Shirts" match even when code/name/
    // description don't; % and , (PostgREST `.or()` separators) are stripped.
    const baseQuery = () => {
      let qy = admin.from("style_master").select(STYLE_SELECT).eq("entity_id", entityId);
      if (!includeDeleted) qy = qy.is("deleted_at", null);
      if (q) {
        const safe = q.replace(/[,%]/g, " ").trim();
        if (safe) {
          qy = qy.or(
            [
              `style_code.ilike.%${safe}%`,
              `style_name.ilike.%${safe}%`,
              `description.ilike.%${safe}%`,
              `group_name.ilike.%${safe}%`,
              `category_name.ilike.%${safe}%`,
              `sub_category_name.ilike.%${safe}%`,
            ].join(","),
          );
        }
      }
      return qy;
    };

    // PostgREST silently caps each request at ~1000 rows, so a single
    // `.limit(10000)` only ever returned the first 1000 styles (alphabetically)
    // — RYB* and anything past the 1000th code were invisible in pickers.
    // Keyset-paginate by style_code to assemble the full set up to `limit`.
    const PAGE = 1000;
    let rows = [];
    let after = null;
    while (rows.length < limit) {
      let pq = baseQuery().order("style_code", { ascending: true }).limit(Math.min(PAGE, limit - rows.length));
      if (after) pq = pq.gt("style_code", after);
      const { data, error } = await pq;
      if (error) return res.status(500).json({ error: error.message });
      const page = data || [];
      rows = rows.concat(page);
      if (page.length < PAGE) break;
      after = page[page.length - 1].style_code;
    }

    // If a search term was supplied, union in any styles whose fabric matches.
    // Cheap second query keeps the join clean and avoids a denormalized view.
    if (q && rows.length < limit) {
      const { data: fabricMatches } = await admin
        .from("fabric_codes")
        .select("id")
        .eq("entity_id", entityId)
        .or(`code.ilike.%${q}%,name.ilike.%${q}%`);
      const fabricIds = (fabricMatches || []).map((r) => r.id);
      if (fabricIds.length > 0) {
        let fabricStyleQuery = admin
          .from("style_master")
          .select(STYLE_SELECT)
          .eq("entity_id", entityId)
          .in("base_fabric_code_id", fabricIds)
          .order("style_code", { ascending: true })
          .limit(limit);
        if (!includeDeleted) fabricStyleQuery = fabricStyleQuery.is("deleted_at", null);
        const { data: byFabric } = await fabricStyleQuery;
        if (Array.isArray(byFabric) && byFabric.length > 0) {
          const seen = new Set(rows.map((r) => r.id));
          for (const r of byFabric) {
            if (!seen.has(r.id)) {
              rows.push(r);
              seen.add(r.id);
            }
          }
          rows.sort((a, b) => String(a.style_code).localeCompare(String(b.style_code)));
        }
      }
    }

    return res.status(200).json(rows);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validateInsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    const row = {
      entity_id: entityId,
      style_code: v.data.style_code.toUpperCase(),
      style_name: v.data.style_name || null,
      description: v.data.description,
      category_id: v.data.category_id || null,
      gender_code: v.data.gender_code || null,
      season: v.data.season || null,
      design_year: v.data.design_year || null,
      is_apparel: v.data.is_apparel !== false,
      launch_date: v.data.launch_date || null,
      lifecycle_status: v.data.lifecycle_status || "active",
      planning_class: v.data.planning_class || null,
      base_fabric_code_id: v.data.base_fabric_code_id || null,
      group_name: v.data.group_name || null,
      category_name: v.data.category_name || null,
      sub_category_name: v.data.sub_category_name || null,
      brand_id: v.data.brand_id || null,
      size_scale_id: v.data.size_scale_id || null,
      rise: v.data.rise || null,
      hts_code: v.data.hts_code || null,
      duty_rate_pct: v.data.duty_rate_pct ?? null,
      additional_tariff_pct: v.data.additional_tariff_pct ?? null,
      unit_weight_kg: v.data.unit_weight_kg ?? null,
      units_per_carton: v.data.units_per_carton ?? null,
      carton_cbm_m3: v.data.carton_cbm_m3 ?? null,
      carton_length_in: v.data.carton_length_in ?? null,
      carton_width_in: v.data.carton_width_in ?? null,
      carton_height_in: v.data.carton_height_in ?? null,
      gross_weight_lb: v.data.gross_weight_lb ?? null,
      cbm_confidence: v.data.cbm_confidence ?? null,
      cbm_note: v.data.cbm_note ?? null,
      cbm_inputs: v.data.cbm_inputs ?? null,
      carton_cbm_override: v.data.carton_cbm_override === true,
      attributes: v.data.attributes || {},
    };

    const { data, error } = await admin
      .from("style_master")
      .insert(row)
      .select(STYLE_SELECT)
      .single();

    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: `style_code '${row.style_code}' already exists for this entity` });
      }
      if (error.code === "23503") {
        return res.status(400).json({ error: "base_fabric_code_id does not reference an existing fabric" });
      }
      return res.status(500).json({ error: error.message });
    }

    // Opt-in GS1 UPC minting (Style Master "Generate UPCs" checkbox). When the
    // operator ticks it, mint one unique UPC-A per (style, color, size) from the
    // company GS1 prefix using the atomic counter. Failure here is non-fatal —
    // the style is already created; we surface the outcome on `upc_minting` so
    // the UI can toast it. Existing Xoro/Excel UPCs are never touched.
    let upcMinting = null;
    if (v.data.generate_upcs === true) {
      try {
        const { mintUpcsForStyle } = await import("../../../_lib/gs1/mintForStyle.js");
        upcMinting = await mintUpcsForStyle(admin, entityId, data);
      } catch (e) {
        upcMinting = { minted: 0, skipped: true, reason: `UPC minting failed: ${e?.message || String(e)}` };
      }
    }

    return res.status(201).json(upcMinting ? { ...data, upc_minting: upcMinting } : data);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validateInsert(body) {
  if (!body.style_code || !String(body.style_code).trim()) {
    return { error: "style_code is required" };
  }
  if (!body.description || !String(body.description).trim()) {
    return { error: "description is required" };
  }
  if (body.gender_code && !GENDER_VALUES.includes(body.gender_code)) {
    return { error: `gender_code must be one of ${GENDER_VALUES.join(", ")}` };
  }
  if (body.lifecycle_status && !LIFECYCLE_VALUES.includes(body.lifecycle_status)) {
    return { error: `lifecycle_status must be one of ${LIFECYCLE_VALUES.join(", ")}` };
  }
  if (body.planning_class && !PLANNING_VALUES.includes(body.planning_class)) {
    return { error: `planning_class must be one of ${PLANNING_VALUES.join(", ")}` };
  }
  if (body.design_year != null) {
    const y = parseInt(body.design_year, 10);
    if (!Number.isFinite(y) || y < 1990 || y > 2100) {
      return { error: "design_year must be between 1990 and 2100" };
    }
    body.design_year = y;
  }
  if (body.base_fabric_code_id != null && body.base_fabric_code_id !== "") {
    if (!UUID_RE.test(String(body.base_fabric_code_id))) {
      return { error: "base_fabric_code_id must be a uuid" };
    }
  } else {
    body.base_fabric_code_id = null;
  }
  // Brand FK (Chunk J, item 4) — uuid or null.
  if (body.brand_id != null && body.brand_id !== "") {
    if (!UUID_RE.test(String(body.brand_id))) {
      return { error: "brand_id must be a uuid" };
    }
  } else {
    body.brand_id = null;
  }
  // Size Scale FK — uuid or null.
  if (body.size_scale_id != null && body.size_scale_id !== "") {
    if (!UUID_RE.test(String(body.size_scale_id))) {
      return { error: "size_scale_id must be a uuid" };
    }
  } else {
    body.size_scale_id = null;
  }
  // Opt-in UPC minting flag — boolean, never persisted on the style row; the
  // handler reads it after insert to mint GS1 UPC-A codes for the new style.
  body.generate_upcs = body.generate_upcs === true || body.generate_upcs === "true";
  // Optional classifier fields — coerce empty strings to null so the
  // handler doesn't persist empty text.
  for (const k of ["group_name", "category_name", "sub_category_name", "rise", "hts_code"]) {
    if (body[k] != null) {
      const trimmed = String(body[k]).trim();
      body[k] = trimmed === "" ? null : trimmed;
    }
  }
  // HTS duty rate % — numeric or null (paired with hts_code).
  if (body.duty_rate_pct != null && String(body.duty_rate_pct).trim() !== "") {
    const n = Number(body.duty_rate_pct);
    body.duty_rate_pct = Number.isFinite(n) ? n : null;
  } else {
    body.duty_rate_pct = null;
  }
  // Additional tariff % (Trump-administration flat +10%) — numeric or null.
  if (body.additional_tariff_pct != null && String(body.additional_tariff_pct).trim() !== "") {
    const n = Number(body.additional_tariff_pct);
    body.additional_tariff_pct = Number.isFinite(n) ? n : null;
  } else {
    body.additional_tariff_pct = null;
  }
  // Logistics roll-up fields (PO total weight / cartons / CBM). Positive numbers
  // or null; units_per_carton is a positive integer.
  for (const k of ["unit_weight_kg", "carton_cbm_m3"]) {
    if (body[k] != null && String(body[k]).trim() !== "") {
      const n = Number(body[k]);
      body[k] = Number.isFinite(n) && n >= 0 ? n : null;
    } else body[k] = null;
  }
  if (body.units_per_carton != null && String(body.units_per_carton).trim() !== "") {
    const n = Math.floor(Number(body.units_per_carton));
    body.units_per_carton = Number.isFinite(n) && n > 0 ? n : null;
  } else body.units_per_carton = null;
  // AI carton-CBM estimate fields. Carton dims + gross weight = non-negative
  // number or null; confidence/note = trimmed text; cbm_inputs = jsonb object;
  // carton_cbm_override = boolean.
  for (const k of ["carton_length_in", "carton_width_in", "carton_height_in", "gross_weight_lb"]) {
    if (body[k] != null && String(body[k]).trim() !== "") {
      const n = Number(body[k]);
      body[k] = Number.isFinite(n) && n >= 0 ? n : null;
    } else body[k] = null;
  }
  for (const k of ["cbm_confidence", "cbm_note"]) {
    if (body[k] != null) { const t = String(body[k]).trim(); body[k] = t === "" ? null : t; }
  }
  if ("cbm_inputs" in body) {
    body.cbm_inputs = body.cbm_inputs && typeof body.cbm_inputs === "object" ? body.cbm_inputs : null;
  }
  if ("carton_cbm_override" in body) body.carton_cbm_override = body.carton_cbm_override === true || body.carton_cbm_override === "true";
  return { data: body };
}
