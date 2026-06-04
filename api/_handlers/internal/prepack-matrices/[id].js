// api/internal/prepack-matrices/[id]
//
// GET    — fetch a single prepack matrix + its size composition.
// PATCH  — update mutable fields + (optionally) replace the composition.
//          `code` and `entity_id` are LOCKED. Mutable: name, ppk_style_code,
//          pack_token, pack_total, notes, is_active, sizes.
//          `sizes` (array of {size, qty_per_pack} OR a {size:qty} map) REPLACES
//          the whole composition when supplied.
// DELETE — hard-delete the matrix; composition rows cascade.
//
// Prepack Matrix Driver master.

import { createClient } from "@supabase/supabase-js";
import { normalizeSizes } from "./index.js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MUTABLE_FIELDS = new Set(["name", "ppk_style_code", "pack_token", "pack_total", "notes", "is_active"]);
const LOCKED_FIELDS = new Set(["code", "entity_id", "id"]);

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

async function fetchWithSizes(admin, id) {
  const { data: m, error } = await admin.from("prepack_matrices").select("*").eq("id", id).maybeSingle();
  if (error) return { error };
  if (!m) return { data: null };
  const { data: sizeRows } = await admin
    .from("prepack_matrix_sizes")
    .select("size, qty_per_pack, inner_pack_qty, sort_order")
    .eq("matrix_id", id)
    .order("sort_order", { ascending: true });
  const sizes = (sizeRows || []).map((s) => ({ size: s.size, qty_per_pack: s.qty_per_pack, inner_pack_qty: s.inner_pack_qty ?? 0, sort_order: s.sort_order }));
  return { data: { ...m, sizes, pack_total_computed: sizes.reduce((a, s) => a + (s.qty_per_pack || 0), 0), inner_packs_computed: sizes.reduce((a, s) => a + (s.inner_pack_qty || 0), 0) } };
}

export function validatePatch(body) {
  if (body == null || typeof body !== "object") {
    return { error: "Request body must be an object" };
  }
  for (const f of Object.keys(body)) {
    if (LOCKED_FIELDS.has(f)) {
      return { error: `${f} is locked post-creation and cannot be updated` };
    }
  }

  const out = {};
  for (const [k, val] of Object.entries(body)) {
    if (MUTABLE_FIELDS.has(k)) out[k] = val;
  }

  if ("name" in out) {
    if (out.name == null || String(out.name).trim() === "") return { error: "name cannot be empty" };
    out.name = String(out.name).trim();
  }
  if ("ppk_style_code" in out) {
    out.ppk_style_code = out.ppk_style_code ? String(out.ppk_style_code).trim() : null;
  }
  if ("pack_token" in out) {
    out.pack_token = out.pack_token ? String(out.pack_token).trim() : null;
  }
  if ("notes" in out) {
    out.notes = out.notes ? String(out.notes).trim() : null;
  }
  if ("pack_total" in out) {
    if (out.pack_total == null || out.pack_total === "") {
      out.pack_total = null;
    } else {
      const n = typeof out.pack_total === "number" ? out.pack_total : parseInt(String(out.pack_total), 10);
      if (!Number.isInteger(n) || n < 0) return { error: "pack_total must be a non-negative integer" };
      out.pack_total = n;
    }
  }
  if ("is_active" in out && typeof out.is_active !== "boolean") {
    out.is_active = out.is_active === "true" || out.is_active === 1;
  }

  // sizes is handled separately (it lives in a child table) — extract it.
  let sizes = null;
  if ("sizes" in body) {
    sizes = normalizeSizes(body.sizes);
    if (sizes.length === 0) return { error: "sizes, when supplied, must include at least one positive qty_per_pack" };
  }

  return { data: out, sizes };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  // Per feedback_dispatcher_query_not_params: read path params from req.query.
  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: "Invalid id" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await fetchWithSizes(admin, id);
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Prepack matrix not found" });
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
    if (Object.keys(v.data).length === 0 && v.sizes == null) {
      return res.status(400).json({ error: "No mutable fields supplied" });
    }

    if (Object.keys(v.data).length > 0) {
      v.data.updated_at = new Date().toISOString();
      const { error } = await admin.from("prepack_matrices").update(v.data).eq("id", id).select("id").single();
      if (error) {
        if (error.code === "PGRST116") return res.status(404).json({ error: "Prepack matrix not found" });
        if (error.code === "23505") return res.status(409).json({ error: "Another matrix already references this PPK style code" });
        return res.status(500).json({ error: error.message });
      }
    }

    if (v.sizes != null) {
      await admin.from("prepack_matrix_sizes").delete().eq("matrix_id", id);
      const rows = v.sizes.map((s) => ({ matrix_id: id, size: s.size, qty_per_pack: s.qty_per_pack, sort_order: s.sort_order }));
      if (rows.length > 0) {
        const { error: sErr } = await admin.from("prepack_matrix_sizes").insert(rows);
        if (sErr) return res.status(500).json({ error: `sizes update failed: ${sErr.message}` });
      }
    }

    const { data, error } = await fetchWithSizes(admin, id);
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Prepack matrix not found" });
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    // Composition rows cascade via the FK ON DELETE CASCADE.
    const { data, error } = await admin
      .from("prepack_matrices").delete().eq("id", id).select("id").maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Prepack matrix not found" });
    return res.status(200).json({ deleted: true, id });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
