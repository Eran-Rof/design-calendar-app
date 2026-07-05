// api/internal/build-orders/[id]/release
//
// POST — snapshot the build's BOM into mfg_build_components and move the build
//        from draft → released. qty_required per component =
//        qty_per_unit × target_qty × (1 + scrap_pct/100). Service components are
//        snapshotted with a suggested charge (service default × qty) + default
//        vendor; the actual charge is captured later via /service.
//
// SIZE-MATCHED consumption: when a BOM PART component is a MATRIX part (a blank
// that comes in sizes) and the build has a per-size plan (mfg_build_outputs),
// the component is expanded into one per-size CHILD component — a size-M output
// consumes the size-M blank. Each child's qty_required = qty_per_unit × the
// produced qty for that size × (1 + scrap). Non-matrix parts snapshot as before.
//
// Uses build.bom_id if set, else the active BOM for the finished item.

import { UUID_RE, corsHeaders, client } from "./_shared.js";
import { resolveOrCreatePartSize } from "../../../_lib/partMatrix.js";

export const config = { maxDuration: 20 };

export default async function handler(req, res) {
  corsHeaders(res, "POST");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: "Invalid id" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: build } = await admin.from("mfg_build_orders").select("*").eq("id", id).maybeSingle();
  if (!build) return res.status(404).json({ error: "Build order not found" });
  if (build.status !== "draft") return res.status(409).json({ error: `Build is '${build.status}', not draft — already released.` });

  // Resolve the BOM (explicit, else the active BOM for the finished STYLE —
  // falling back to the representative finished_item_id for pre-style BOMs).
  let bomId = build.bom_id;
  if (!bomId) {
    let activeBom = null;
    if (build.finished_style_id) {
      // Prefer a customer-specific active BOM for this build's customer, else
      // the generic (customer-less) active BOM for the style.
      if (build.customer_id) {
        ({ data: activeBom } = await admin.from("mfg_bom")
          .select("id").eq("entity_id", build.entity_id).eq("finished_style_id", build.finished_style_id).eq("customer_id", build.customer_id).eq("status", "active").maybeSingle());
      }
      if (!activeBom) {
        ({ data: activeBom } = await admin.from("mfg_bom")
          .select("id").eq("entity_id", build.entity_id).eq("finished_style_id", build.finished_style_id).is("customer_id", null).eq("status", "active").maybeSingle());
      }
    }
    if (!activeBom) {
      ({ data: activeBom } = await admin.from("mfg_bom")
        .select("id").eq("entity_id", build.entity_id).eq("finished_item_id", build.finished_item_id).eq("status", "active").maybeSingle());
    }
    if (!activeBom) return res.status(400).json({ error: "No BOM on this build and no active BOM for the finished style. Create/activate a BOM first." });
    bomId = activeBom.id;
  }

  const { data: bomComps } = await admin.from("mfg_bom_components").select("*").eq("bom_id", bomId).order("line_number", { ascending: true });
  if (!bomComps || bomComps.length === 0) return res.status(400).json({ error: "The BOM has no components." });

  // Seed service defaults (vendor + default per-unit charge).
  const svcIds = bomComps.filter((c) => c.service_item_id).map((c) => c.service_item_id);
  const svcDefaults = new Map();
  if (svcIds.length) {
    const { data: svcs } = await admin.from("service_item_master").select("id, default_vendor_id, default_charge_cents").in("id", svcIds);
    for (const s of svcs || []) svcDefaults.set(s.id, s);
  }

  const target = Number(build.target_qty);

  // Per-size plan (matrix builds) → total produced qty by SIZE (parts vary only
  // by size, so aggregate across colors). Drives size-matched part consumption.
  const { data: outputs } = await admin.from("mfg_build_outputs").select("size, qty").eq("build_order_id", id);
  const qtyBySize = new Map();
  for (const o of outputs || []) {
    const sz = (o.size || "").trim();
    if (!sz) continue;
    qtyBySize.set(sz, (qtyBySize.get(sz) || 0) + Number(o.qty || 0));
  }

  // Which PART components reference a MATRIX parent part (→ consume per-size child).
  const partIds = bomComps.filter((c) => c.component_kind === "part" && c.part_id).map((c) => c.part_id);
  const matrixParents = new Set();
  if (partIds.length) {
    const { data: pm } = await admin.from("part_master").select("id, is_matrix").in("id", partIds);
    for (const p of pm || []) if (p.is_matrix) matrixParents.add(p.id);
  }

  // Seed service_capitalized on EVERY row (not just service rows): PostgREST unions
  // the keys across a multi-row insert, so once any service row carries the column
  // it's sent for all rows — a part/finished_style row that omitted it would get an
  // explicit null, bypassing the DB DEFAULT false and violating NOT NULL.
  const rows = [];
  let ln = 0;
  for (const c of bomComps) {
    const scrap = 1 + Number(c.scrap_pct) / 100;

    // Size-matched: a matrix-part component expands into one child per produced size.
    if (c.component_kind === "part" && matrixParents.has(c.part_id)) {
      if (qtyBySize.size === 0) {
        return res.status(400).json({ error: "This build's BOM has a size-matched (matrix) part but the build has no per-size plan — add a size matrix to the build, or use a non-matrix part." });
      }
      for (const [sz, sizeQty] of qtyBySize.entries()) {
        if (sizeQty <= 0) continue;
        const resolved = await resolveOrCreatePartSize(admin, build.entity_id, { parent_part_id: c.part_id, size: sz });
        if (resolved.error) return res.status(400).json({ error: `Size-matched consumption failed (part ${c.part_id}, size ${sz}): ${resolved.error}` });
        rows.push({
          build_order_id: id, component_kind: "part", part_id: resolved.id,
          service_item_id: null, component_item_id: null,
          qty_required: Math.round(Number(c.qty_per_unit) * sizeQty * scrap * 10000) / 10000,
          qty_consumed: 0, actual_cost_cents: 0, service_capitalized: false, line_number: ++ln,
        });
      }
      continue;
    }

    // Default: one row scaled by the whole build's target qty.
    const qtyRequired = Math.round(Number(c.qty_per_unit) * target * scrap * 10000) / 10000;
    const row = {
      build_order_id: id, component_kind: c.component_kind, part_id: c.part_id,
      service_item_id: c.service_item_id, component_item_id: c.component_item_id,
      qty_required: qtyRequired, qty_consumed: 0, actual_cost_cents: 0,
      service_capitalized: false, line_number: ++ln,
    };
    if (c.component_kind === "service") {
      const def = svcDefaults.get(c.service_item_id);
      row.service_vendor_id = def?.default_vendor_id || null;
      row.service_charge_cents = def?.default_charge_cents != null ? Math.round(def.default_charge_cents * qtyRequired) : null;
    }
    rows.push(row);
  }

  // Replace any prior snapshot (defensive) then insert.
  await admin.from("mfg_build_components").delete().eq("build_order_id", id);
  const { error: insErr } = await admin.from("mfg_build_components").insert(rows);
  if (insErr) return res.status(400).json({ error: `Component snapshot failed: ${insErr.message}` });

  const { data: updated, error: upErr } = await admin.from("mfg_build_orders")
    .update({ status: "released", bom_id: bomId, updated_at: new Date().toISOString() })
    .eq("id", id).eq("status", "draft").select().single();
  if (upErr) return res.status(500).json({ error: upErr.message });

  return res.status(200).json({ ...updated, component_count: rows.length });
}
