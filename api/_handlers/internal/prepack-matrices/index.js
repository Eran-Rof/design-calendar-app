// api/internal/prepack-matrices
//
// Prepack Matrix Driver master. A prepack matrix defines the per-size garment
// composition of one prepack (PPK) pack, so the Inventory Matrix "Explode PPK"
// toggle can convert packs on-hand into garment-size eaches.
//
// GET   — list matrices for the default entity (joined with their size
//         composition rows). By default is_active=true only.
//         Query:
//           ?q=<search>             — ilike on code / name / ppk_style_code
//           ?include_inactive=true  — include inactive rows
//           ?ppk_style_code=<code>  — exact (case-insensitive) PPK style match
// POST  — create one matrix + its composition rows. Body:
//           { name (required),
//             ppk_style_code (optional — the PPK style_code in ip_item_master),
//             pack_token (optional — e.g. PPK24),
//             pack_total (optional integer),
//             notes (optional),
//             is_active (default true),
//             sizes: [{ size, qty_per_pack }] OR { "<size>": <qty>, … } (required) }
//         `code` is SERVER-GENERATED (PPKM-NNNNN); any client-supplied code is
//         ignored. Auto-coded master — same scheme as size_scales (SCALE-).
//
// Mirrors the size-scales handler shape (resolveDefaultEntityId + ROF scope;
// service-role writes; anon-read in DB). UPSERT-on-create when ppk_style_code
// matches an existing matrix (idempotent re-import from the Excel template).

import { createClient } from "@supabase/supabase-js";
import { insertWithAutoCode } from "../../../_lib/autoCode.js";

export const config = { maxDuration: 30 };

const CODE_PREFIX = "PPKM-";

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
    .from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (error || !data) return null;
  return data.id;
}

// Normalize a `sizes` payload to an ordered array of { size, qty_per_pack }.
// Accepts either an array of { size, qty_per_pack } objects OR an object map
// { "<size>": <qty> }. Blank sizes and non-positive/NaN qtys are dropped.
// Duplicate sizes (last wins) are folded by summing? No — last wins, matching
// the (matrix_id, size) UNIQUE; we keep the LAST value seen for a size.
export function normalizeSizes(input) {
  const out = new Map(); // size(string) → { size, qty_per_pack }
  let order = 0;
  const push = (rawSize, rawQty) => {
    const size = rawSize == null ? "" : String(rawSize).trim();
    if (size === "") return;
    const qty = typeof rawQty === "number" ? rawQty : parseInt(String(rawQty ?? "").trim(), 10);
    if (!Number.isInteger(qty) || qty < 0) return;
    if (qty === 0) { out.delete(size); return; } // 0 means "not in this pack"
    const existing = out.get(size);
    out.set(size, { size, qty_per_pack: qty, sort_order: existing ? existing.sort_order : order++ });
  };
  if (Array.isArray(input)) {
    for (const row of input) {
      if (row == null) continue;
      push(row.size ?? row.Size ?? row.SIZE, row.qty_per_pack ?? row.qty ?? row.Qty ?? row.QTY);
    }
  } else if (input && typeof input === "object") {
    for (const [k, v] of Object.entries(input)) push(k, v);
  }
  return [...out.values()];
}

export function validateInsert(body) {
  if (body == null || typeof body !== "object") {
    return { error: "Request body must be an object" };
  }
  if (!body.name || !String(body.name).trim()) {
    return { error: "name is required" };
  }
  const sizes = normalizeSizes(body.sizes);
  if (sizes.length === 0) {
    return { error: "at least one size with a positive qty_per_pack is required" };
  }

  let packTotal = null;
  if (body.pack_total != null && body.pack_total !== "") {
    packTotal = typeof body.pack_total === "number" ? body.pack_total : parseInt(String(body.pack_total), 10);
    if (!Number.isInteger(packTotal) || packTotal < 0) {
      return { error: "pack_total must be a non-negative integer" };
    }
  }

  const isActive = body.is_active == null ? true :
    typeof body.is_active === "boolean" ? body.is_active :
      body.is_active === "true" || body.is_active === 1;

  return {
    data: {
      name:           String(body.name).trim(),
      ppk_style_code: body.ppk_style_code ? String(body.ppk_style_code).trim() : null,
      pack_token:     body.pack_token ? String(body.pack_token).trim() : null,
      pack_total:     packTotal,
      notes:          body.notes ? String(body.notes).trim() : null,
      is_active:      isActive,
    },
    sizes,
  };
}

// Replace the composition rows for a matrix wholesale (delete + insert).
async function writeSizes(admin, matrixId, sizes) {
  await admin.from("prepack_matrix_sizes").delete().eq("matrix_id", matrixId);
  if (sizes.length === 0) return { error: null };
  const rows = sizes.map((s) => ({
    matrix_id: matrixId, size: s.size, qty_per_pack: s.qty_per_pack, sort_order: s.sort_order,
  }));
  const { error } = await admin.from("prepack_matrix_sizes").insert(rows);
  return { error };
}

// Fetch matrices with their composition rows folded in.
async function listWithSizes(admin, matrixRows) {
  const ids = matrixRows.map((m) => m.id);
  const bySize = new Map();
  if (ids.length > 0) {
    const { data: sizeRows } = await admin
      .from("prepack_matrix_sizes")
      .select("matrix_id, size, qty_per_pack, sort_order")
      .in("matrix_id", ids)
      .order("sort_order", { ascending: true });
    for (const r of sizeRows || []) {
      const arr = bySize.get(r.matrix_id) || [];
      arr.push({ size: r.size, qty_per_pack: r.qty_per_pack, sort_order: r.sort_order });
      bySize.set(r.matrix_id, arr);
    }
  }
  return matrixRows.map((m) => {
    const sizes = bySize.get(m.id) || [];
    return { ...m, sizes, pack_total_computed: sizes.reduce((a, s) => a + (s.qty_per_pack || 0), 0) };
  });
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
    const includeInactive = url.searchParams.get("include_inactive") === "true";
    const q = (url.searchParams.get("q") || "").trim();
    const ppkStyle = (url.searchParams.get("ppk_style_code") || "").trim();

    let query = admin
      .from("prepack_matrices").select("*").eq("entity_id", entityId)
      .order("code", { ascending: true });

    if (!includeInactive) query = query.eq("is_active", true);
    if (ppkStyle) query = query.ilike("ppk_style_code", ppkStyle);
    if (q) {
      const esc = q.replace(/[,()]/g, " ");
      query = query.or(`code.ilike.%${esc}%,name.ilike.%${esc}%,ppk_style_code.ilike.%${esc}%`);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    const withSizes = await listWithSizes(admin, data || []);
    return res.status(200).json(withSizes);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validateInsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    // Idempotent upsert by (entity, ppk_style_code): if a matrix already exists
    // for this PPK style, UPDATE it in place (re-import path). Otherwise insert
    // with a freshly-generated code.
    let matrix = null;
    if (v.data.ppk_style_code) {
      const { data: existing } = await admin
        .from("prepack_matrices").select("*")
        .eq("entity_id", entityId)
        .ilike("ppk_style_code", v.data.ppk_style_code)
        .maybeSingle();
      if (existing) {
        const { data: updated, error: upErr } = await admin
          .from("prepack_matrices")
          .update({ ...v.data, updated_at: new Date().toISOString() })
          .eq("id", existing.id)
          .select().single();
        if (upErr) return res.status(500).json({ error: upErr.message });
        matrix = updated;
      }
    }

    if (!matrix) {
      const buildRow = (code) => ({ ...v.data, code, entity_id: entityId });
      const { data, error } = await insertWithAutoCode(
        admin, "prepack_matrices", "code", CODE_PREFIX, buildRow, { entityId },
      );
      if (error) {
        if (error.code === "23505") {
          return res.status(409).json({ error: "Could not allocate a unique matrix code (or PPK style already has a matrix); please retry" });
        }
        return res.status(500).json({ error: error.message });
      }
      matrix = data;
    }

    const { error: sErr } = await writeSizes(admin, matrix.id, v.sizes);
    if (sErr) return res.status(500).json({ error: `matrix saved but sizes failed: ${sErr.message}` });

    const [withSizes] = await listWithSizes(admin, [matrix]);
    return res.status(201).json(withSizes);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
