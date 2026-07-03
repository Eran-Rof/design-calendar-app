// api/internal/mfg-boms/_validate.js
//
// Shared validation for BOM component arrays (used by index POST + [id] PATCH).
// Each component: { component_kind, part_id|service_item_id|component_item_id,
//                   qty_per_unit?, scrap_pct?, cost_source? }
// Helper file (underscore-prefixed) — imported, never routed.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = new Set(["part", "service", "finished_style"]);
const COST_SOURCES = new Set(["fifo", "default"]);
const REF_FOR_KIND = { part: "part_id", service: "service_item_id", finished_style: "component_item_id" };

/**
 * @param {unknown} components
 * @returns {{ rows: object[] } | { error: string }}
 */
export function validateComponents(components) {
  if (components == null) return { rows: [] };
  if (!Array.isArray(components)) return { error: "components must be an array" };

  const rows = [];
  for (let i = 0; i < components.length; i++) {
    const c = components[i] || {};
    const kind = String(c.component_kind || "").trim();
    if (!KINDS.has(kind)) return { error: `components[${i}].component_kind must be one of: part, service, finished_style` };

    const refField = REF_FOR_KIND[kind];
    const refVal = c[refField];
    if (!refVal || !UUID_RE.test(String(refVal))) {
      return { error: `components[${i}].${refField} (uuid) is required for component_kind '${kind}'` };
    }

    let qty = 1;
    if (c.qty_per_unit != null && c.qty_per_unit !== "") {
      qty = Number(c.qty_per_unit);
      if (!Number.isFinite(qty) || qty <= 0) return { error: `components[${i}].qty_per_unit must be > 0` };
    }
    let scrap = 0;
    if (c.scrap_pct != null && c.scrap_pct !== "") {
      scrap = Number(c.scrap_pct);
      if (!Number.isFinite(scrap) || scrap < 0 || scrap >= 100) return { error: `components[${i}].scrap_pct must be in [0, 100)` };
    }
    const costSource = c.cost_source && COST_SOURCES.has(String(c.cost_source)) ? String(c.cost_source) : "fifo";

    // Optional per-component unit-cost override (cents). Only meaningful for
    // service components (negotiated charge), but stored uniformly. NULL = use
    // the master default.
    let unitCostCents = null;
    if (c.unit_cost_cents != null && c.unit_cost_cents !== "") {
      const n = Number(c.unit_cost_cents);
      if (!Number.isFinite(n) || n < 0) return { error: `components[${i}].unit_cost_cents must be >= 0` };
      unitCostCents = Math.round(n);
    }

    rows.push({
      component_kind: kind,
      part_id: kind === "part" ? String(refVal) : null,
      service_item_id: kind === "service" ? String(refVal) : null,
      component_item_id: kind === "finished_style" ? String(refVal) : null,
      qty_per_unit: qty,
      scrap_pct: scrap,
      cost_source: costSource,
      unit_cost_cents: unitCostCents,
    });
  }
  return { rows };
}
