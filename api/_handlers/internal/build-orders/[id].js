// api/internal/build-orders/[id]
//
// GET    — build header + components (resolved labels) + finished-item label +
//          a WIP cost rollup (parts / consumed-style / service / total).
// PATCH  — notes, cancel (status→cancelled from draft|released only — an issued
//          build has consumed stock into WIP, so it can't be cancelled without
//          a reversing entry), conversion_po_id / conversion_po_line_id linkage.
// DELETE — only a draft or cancelled build (components cascade).

import { UUID_RE, corsHeaders, client } from "./_shared.js";

export const config = { maxDuration: 20 };

async function decorateComponents(admin, buildId) {
  const { data: comps } = await admin.from("mfg_build_components").select("*").eq("build_order_id", buildId).order("line_number", { ascending: true });
  const list = comps || [];
  const partIds = list.filter((c) => c.part_id).map((c) => c.part_id);
  const svcIds = list.filter((c) => c.service_item_id).map((c) => c.service_item_id);
  const itemIds = list.filter((c) => c.component_item_id).map((c) => c.component_item_id);
  const vendIds = list.filter((c) => c.service_vendor_id).map((c) => c.service_vendor_id);

  const [parts, svcs, items, vends] = await Promise.all([
    // #8 — carry the master default costs so a component's projected cost can be
    // shown before it is issued/capitalized (actual_cost_cents is 0 until posted).
    partIds.length ? admin.from("part_master").select("id, code, name, default_unit_cost_cents").in("id", partIds) : Promise.resolve({ data: [] }),
    svcIds.length ? admin.from("service_item_master").select("id, code, name, default_charge_cents").in("id", svcIds) : Promise.resolve({ data: [] }),
    itemIds.length ? admin.from("ip_item_master").select("id, sku_code, description, unit_cost").in("id", itemIds) : Promise.resolve({ data: [] }),
    vendIds.length ? admin.from("vendors").select("id, legal_name, code").in("id", vendIds) : Promise.resolve({ data: [] }),
  ]);
  const partBy = new Map((parts.data || []).map((p) => [p.id, p]));
  const svcBy = new Map((svcs.data || []).map((s) => [s.id, s]));
  const itemBy = new Map((items.data || []).map((i) => [i.id, i]));
  const vendBy = new Map((vends.data || []).map((v) => [v.id, v]));

  // #8 — projected UNIT cost for consumed finished-styles: prefer the all-SKU
  // avg-cost table (ip_item_avg_cost, keyed by sku_code, stored in DOLLARS),
  // fall back to the item's own unit_cost (also dollars). Fetched once for all
  // style components.
  const skuCodes = [...new Set((items.data || []).map((i) => i.sku_code).filter(Boolean))];
  const avgBySku = new Map();
  if (skuCodes.length) {
    const { data: avgRows } = await admin.from("ip_item_avg_cost").select("sku_code, avg_cost").in("sku_code", skuCodes);
    for (const a of avgRows || []) avgBySku.set(a.sku_code, Number(a.avg_cost));
  }

  return list.map((c) => {
    let code = null, label = null, projectedUnitCents = null;
    if (c.component_kind === "part" && partBy.get(c.part_id)) {
      const p = partBy.get(c.part_id);
      code = p.code; label = p.name;
      projectedUnitCents = p.default_unit_cost_cents != null ? Number(p.default_unit_cost_cents) : null;
    } else if (c.component_kind === "service" && svcBy.get(c.service_item_id)) {
      const s = svcBy.get(c.service_item_id);
      code = s.code; label = s.name;
      // A capitalized service uses its agreed charge; otherwise the master default.
      projectedUnitCents = c.service_charge_cents != null ? Number(c.service_charge_cents)
        : (s.default_charge_cents != null ? Number(s.default_charge_cents) : null);
    } else if (c.component_kind === "finished_style" && itemBy.get(c.component_item_id)) {
      const it = itemBy.get(c.component_item_id);
      code = it.sku_code; label = it.description;
      const avgDollars = avgBySku.has(it.sku_code) ? avgBySku.get(it.sku_code)
        : (it.unit_cost != null ? Number(it.unit_cost) : null);
      projectedUnitCents = avgDollars != null && Number.isFinite(avgDollars) ? Math.round(avgDollars * 100) : null;
    }
    // Projected EXTENDED cost = unit × qty_required (services are per-build, so
    // qty_required is typically 1). Null unit ⇒ unknown (no default on record).
    const qtyReq = Number(c.qty_required || 0);
    const projectedCostCents = projectedUnitCents != null
      ? (c.component_kind === "service" ? projectedUnitCents : Math.round(projectedUnitCents * qtyReq))
      : null;
    return {
      ...c,
      component_code: code,
      component_label: label,
      service_vendor_name: c.service_vendor_id ? (vendBy.get(c.service_vendor_id)?.legal_name || null) : null,
      projected_unit_cost_cents: projectedUnitCents,
      projected_cost_cents: projectedCostCents,
    };
  });
}

function rollup(components) {
  // Actual (posted) rollup + a PROJECTED rollup (#8) so costs are visible before
  // issue/capitalize. Projected falls back to actual once posted (actual > 0),
  // and to the projected estimate before that.
  const r = { parts_cost_cents: 0, style_cost_cents: 0, service_cost_cents: 0, total_cents: 0 };
  const p = { parts_cost_cents: 0, style_cost_cents: 0, service_cost_cents: 0, total_cents: 0, has_estimate: false, missing_costs: 0 };
  for (const c of components) {
    const actual = Number(c.actual_cost_cents || 0);
    const projected = actual > 0 ? actual : (c.projected_cost_cents != null ? Number(c.projected_cost_cents) : 0);
    if (c.projected_cost_cents == null && actual === 0) p.missing_costs += 1;
    else p.has_estimate = true;
    if (c.component_kind === "part") { r.parts_cost_cents += actual; p.parts_cost_cents += projected; }
    else if (c.component_kind === "finished_style") { r.style_cost_cents += actual; p.style_cost_cents += projected; }
    else if (c.component_kind === "service") { r.service_cost_cents += actual; p.service_cost_cents += projected; }
  }
  r.total_cents = r.parts_cost_cents + r.style_cost_cents + r.service_cost_cents;
  p.total_cents = p.parts_cost_cents + p.style_cost_cents + p.service_cost_cents;
  r.projected = p;
  return r;
}

export default async function handler(req, res) {
  corsHeaders(res, "GET, PATCH, DELETE");
  if (req.method === "OPTIONS") return res.status(200).end();

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: "Invalid id" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data: build, error } = await admin.from("mfg_build_orders").select("*").eq("id", id).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!build) return res.status(404).json({ error: "Build order not found" });
    const { data: fi } = build.finished_item_id
      ? await admin.from("ip_item_master").select("id, sku_code, style_code, style_id, color, description").eq("id", build.finished_item_id).maybeSingle()
      : { data: null };
    // Finished good = a style. Prefer the build's own finished_style_id column;
    // fall back to the representative item's style.
    const styleId = build.finished_style_id || fi?.style_id || null;
    let finishedStyle = null;
    if (styleId) {
      const { data: st } = await admin.from("style_master").select("id, style_code, style_name").eq("id", styleId).maybeSingle();
      finishedStyle = st || null;
    }
    const components = await decorateComponents(admin, id);
    // Phase A — per-size outputs (planned at creation, actuals once completed).
    const { data: outputs } = await admin.from("mfg_build_outputs").select("id, item_id, color, size, qty, unit_cost_cents").eq("build_order_id", id).order("created_at", { ascending: true });
    // Phase B — customer this build is for + that customer's style number.
    let customerName = null, customerStyleNumber = null;
    if (build.customer_id) {
      const { data: cust } = await admin.from("customers").select("name").eq("id", build.customer_id).maybeSingle();
      customerName = cust?.name || null;
      if (styleId) {
        const { data: scn } = await admin.from("style_customer_numbers").select("customer_style_number")
          .eq("style_id", styleId).eq("customer_id", build.customer_id).maybeSingle();
        customerStyleNumber = scn?.customer_style_number || null;
      }
    }
    return res.status(200).json({
      ...build,
      finished_item: fi || null,
      finished_style_id: styleId,
      finished_style: finishedStyle,
      customer_name: customerName,
      customer_style_number: customerStyleNumber,
      components,
      outputs: outputs || [],
      rollup: rollup(components),
    });
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    body = body || {};

    const { data: build } = await admin.from("mfg_build_orders").select("*").eq("id", id).maybeSingle();
    if (!build) return res.status(404).json({ error: "Build order not found" });

    const patch = {};
    if ("notes" in body) patch.notes = body.notes ? String(body.notes).trim() || null : null;
    if ("conversion_po_id" in body) {
      if (body.conversion_po_id && !UUID_RE.test(String(body.conversion_po_id))) return res.status(400).json({ error: "conversion_po_id must be a uuid" });
      patch.conversion_po_id = body.conversion_po_id || null;
    }
    if ("conversion_po_line_id" in body) {
      if (body.conversion_po_line_id && !UUID_RE.test(String(body.conversion_po_line_id))) return res.status(400).json({ error: "conversion_po_line_id must be a uuid" });
      patch.conversion_po_line_id = body.conversion_po_line_id || null;
    }
    if (body.status === "cancelled") {
      if (build.status === "completed") return res.status(409).json({ error: "Cannot cancel a completed build" });
      // An ISSUED build has FIFO-consumed its parts/styles into WIP and posted a
      // DR-WIP journal entry. A plain PATCH can't unwind that. The dedicated
      // POST /build-orders/:id/cancel action reverses the issue + service JEs and
      // restores the consumed inventory (T11 reason required) — use it instead.
      // PATCH only cancels draft/released builds (nothing consumed yet).
      if (build.status === "issued") return res.status(409).json({ error: "Cannot cancel an issued build via PATCH — use POST /build-orders/:id/cancel, which reverses the WIP postings and restores the consumed parts/styles." });
      patch.status = "cancelled";
    } else if (body.status != null) {
      return res.status(400).json({ error: "Use the /release, /issue, /complete endpoints to advance status; PATCH only cancels." });
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: "No mutable fields supplied" });
    patch.updated_at = new Date().toISOString();

    const { data, error } = await admin.from("mfg_build_orders").update(patch).eq("id", id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    const { data: build } = await admin.from("mfg_build_orders").select("status").eq("id", id).maybeSingle();
    if (!build) return res.status(404).json({ error: "Build order not found" });
    if (!["draft", "cancelled"].includes(build.status)) {
      return res.status(409).json({ error: `Cannot delete a build in status '${build.status}'. Cancel it first (a posted build keeps its journal entries).` });
    }
    const { error } = await admin.from("mfg_build_orders").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ deleted: true, id });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
