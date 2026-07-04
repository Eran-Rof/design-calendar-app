// api/_lib/partMatrix.js
//
// Matrix (by-size) manufacturing parts — the parts analogue of styleMatrix.js.
// A matrix PARENT part (part_master.is_matrix) has one CHILD part row per size
// (parent_part_id + size), each carrying its own FIFO inventory. This module
// find-or-creates those children (resolveOrCreatePartSize) and enumerates a
// parent's size matrix with per-size on-hand (enumeratePartMatrix) — mirrors
// resolveOrCreateSku / enumerateStyleMatrix but far simpler (no color/apparel
// dims: a part varies only by size).

// Uppercase-safe token for a child part code segment.
const SAFE = (s) => String(s || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "");

/**
 * Find (or create) the per-size CHILD part_master row for a matrix parent.
 * @returns {Promise<{id:string, created:boolean} | {error:string}>}
 */
export async function resolveOrCreatePartSize(admin, entityId, { parent_part_id, size }) {
  if (!parent_part_id || !size) return { error: "parent_part_id and size required" };
  const sizeVal = String(size).trim();
  if (!sizeVal) return { error: "size required" };

  // Reuse an existing child for this (parent, size) — case-insensitive.
  {
    const { data: rows } = await admin.from("part_master")
      .select("id, size").eq("entity_id", entityId).eq("parent_part_id", parent_part_id);
    const hit = (rows || []).find((r) => String(r.size || "").trim().toLowerCase() === sizeVal.toLowerCase());
    if (hit) return { id: hit.id, created: false };
  }

  // Load the parent so the child inherits its type / uom / vendor / cost / fabric.
  const { data: parent } = await admin.from("part_master")
    .select("code, name, part_type, uom, default_vendor_id, default_unit_cost_cents, fabric_code_id, is_matrix, entity_id")
    .eq("id", parent_part_id).maybeSingle();
  if (!parent) return { error: "parent part not found" };
  if (!parent.is_matrix) return { error: "part is not a matrix part" };

  const base = `${parent.code}-${SAFE(sizeVal)}` || parent.code;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = attempt === 0 ? base : `${base}-${attempt}`;
    const { data: created, error } = await admin.from("part_master").insert({
      entity_id: entityId, code, name: `${parent.name} ${sizeVal}`.trim(),
      part_type: parent.part_type, uom: parent.uom || "each",
      default_vendor_id: parent.default_vendor_id || null,
      default_unit_cost_cents: parent.default_unit_cost_cents ?? null,
      fabric_code_id: parent.fabric_code_id || null,
      is_size_scaled: true, is_matrix: false, parent_part_id, size: sizeVal, is_active: true,
    }).select("id").single();
    if (!error && created) return { id: created.id, created: true };
    if (error && error.code !== "23505") return { error: error.message };
    // 23505 → either the (parent,size) unique index (a race created it) or the
    // (entity,code) unique. Re-find by (parent,size) first; else bump the suffix.
    const { data: again } = await admin.from("part_master")
      .select("id").eq("entity_id", entityId).eq("parent_part_id", parent_part_id).ilike("size", sizeVal).maybeSingle();
    if (again?.id) return { id: again.id, created: false };
  }
  return { error: "could not allocate a unique child part code" };
}

/**
 * A matrix parent's size list + per-size children with on-hand.
 * @returns {Promise<{part, sizes:string[], children:Array} | {error:string}>}
 */
export async function enumeratePartMatrix(admin, entityId, parentPartId) {
  const { data: part } = await admin.from("part_master")
    .select("id, code, name, uom, is_matrix, size_scale_id").eq("id", parentPartId).eq("entity_id", entityId).maybeSingle();
  if (!part) return { error: "part not found" };

  // Sizes: prefer the assigned size scale; else the distinct sizes of existing children.
  let sizes = [];
  if (part.size_scale_id) {
    const { data: scale } = await admin.from("size_scales").select("sizes").eq("id", part.size_scale_id).maybeSingle();
    sizes = Array.isArray(scale?.sizes) ? scale.sizes.filter(Boolean).map(String) : [];
  }

  const { data: kids } = await admin.from("part_master")
    .select("id, code, size, default_unit_cost_cents").eq("entity_id", entityId).eq("parent_part_id", parentPartId);
  const children = kids || [];

  // Per-child on-hand + avg cost from part_inventory_layers.
  const byChild = new Map();
  if (children.length) {
    const { data: layers } = await admin.from("part_inventory_layers")
      .select("part_id, remaining_qty, unit_cost_cents").in("part_id", children.map((c) => c.id));
    for (const l of layers || []) {
      const acc = byChild.get(l.part_id) || { qty: 0, cost: 0 };
      const q = Number(l.remaining_qty) || 0;
      acc.qty += q; acc.cost += q * (Number(l.unit_cost_cents) || 0);
      byChild.set(l.part_id, acc);
    }
  }
  const decoratedChildren = children.map((c) => {
    const acc = byChild.get(c.id) || { qty: 0, cost: 0 };
    return {
      id: c.id, size: c.size, code: c.code,
      on_hand_qty: acc.qty,
      avg_cost_cents: acc.qty > 0 ? Math.round(acc.cost / acc.qty) : (c.default_unit_cost_cents ?? null),
    };
  });
  // If the scale gave no sizes, surface the children's sizes (ordered by code).
  if (!sizes.length) sizes = decoratedChildren.map((c) => c.size).filter(Boolean);

  return { part: { id: part.id, code: part.code, name: part.name, uom: part.uom }, sizes, children: decoratedChildren };
}
