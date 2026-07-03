// api/internal/build-orders/[id]/conversion-po
//
// M11 — auto-create the CONVERSION PO for an outsourced-CMT build.
//
// POST { vendor_id?, mode?, unit_cost_cents? }
//   • vendor_id       — the conversion vendor. Defaults to the build's BOM
//                       default_conversion_vendor_id.
//   • mode            — 'procurement' (default) | 'capitalize' (see the
//                       20260950000000 migration for what each does to GL).
//   • unit_cost_cents — per-unit CMT charge on the single PO line (default 0).
//
// Creates a native DRAFT purchase_order (one line to the finished good, qty =
// build target/completed qty, description "CMT: <build_number>") by REUSING the
// purchase-orders create handler, then stamps mfg_build_orders.conversion_po_id
// + conversion_po_mode.
//
// Guards: the build must not be completed/cancelled, and a second PO is never
// created — if conversion_po_id is already set the existing PO is returned.
//
// NB: this endpoint posts NO GL. In 'procurement' mode the PO is a document
// only; in 'capitalize' mode the CMT is capitalized into WIP by the PO's AP
// bill when it is posted (reviewed separately — see the PR that adds this).

import poCreateHandler from "../purchase-orders/index.js";
import { UUID_RE, corsHeaders, client } from "./_shared.js";

export const config = { maxDuration: 20 };

const MODES = ["procurement", "capitalize"];

// Reuse the native purchase-orders POST handler by invoking it with a captured
// req/res. This runs the SAME validation, entity resolution, header
// normalization and line insert as the public endpoint (no rewrite).
async function createDraftPo(poBody) {
  const req = { method: "POST", url: "/api/internal/purchase-orders", headers: {}, query: {}, body: poBody };
  let statusCode = 200;
  let payload = null;
  const res = {
    setHeader() {},
    status(c) { statusCode = c; return this; },
    json(p) { payload = p; return this; },
    end() { return this; },
  };
  await poCreateHandler(req, res);
  return { statusCode, payload };
}

// Small summary of a linked PO for the response / build detail.
async function poSummary(admin, poId) {
  const { data } = await admin.from("purchase_orders").select("id, po_number, status, vendor_id, total_cents").eq("id", poId).maybeSingle();
  return data || null;
}

export default async function handler(req, res) {
  corsHeaders(res, "POST");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: "Invalid id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  body = body || {};

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: build } = await admin.from("mfg_build_orders").select("*").eq("id", id).maybeSingle();
  if (!build) return res.status(404).json({ error: "Build order not found" });
  if (build.status === "completed" || build.status === "cancelled") {
    return res.status(409).json({ error: `Cannot create a conversion PO for a '${build.status}' build.` });
  }

  // Idempotent: never create a second PO. Return the linked one.
  if (build.conversion_po_id) {
    const existing = await poSummary(admin, build.conversion_po_id);
    return res.status(200).json({
      build_order_id: id,
      conversion_po_id: build.conversion_po_id,
      conversion_po_mode: build.conversion_po_mode || "procurement",
      purchase_order: existing,
      already_linked: true,
      message: existing?.po_number ? `Conversion PO ${existing.po_number} already linked.` : "Conversion PO already linked.",
    });
  }

  // Mode: body → 'procurement' default.
  const mode = MODES.includes(body.mode) ? body.mode : "procurement";

  // Vendor: body → BOM default_conversion_vendor_id.
  let vendorId = body.vendor_id && UUID_RE.test(String(body.vendor_id)) ? String(body.vendor_id) : null;
  if (!vendorId && build.bom_id) {
    const { data: bom } = await admin.from("mfg_bom").select("default_conversion_vendor_id").eq("id", build.bom_id).maybeSingle();
    vendorId = bom?.default_conversion_vendor_id || null;
  }
  if (!vendorId) {
    return res.status(400).json({ error: "No conversion vendor — pass vendor_id or set the BOM's default conversion vendor." });
  }

  // Single line to the finished good, qty = target (fall back to completed).
  const qty = Number(build.target_qty) || Number(build.completed_qty) || 0;
  if (qty <= 0) return res.status(409).json({ error: "Build has no target/completed quantity to order." });
  const unitCostCents = body.unit_cost_cents == null || body.unit_cost_cents === ""
    ? 0
    : Math.round(Number(body.unit_cost_cents));
  if (!Number.isFinite(unitCostCents) || unitCostCents < 0) {
    return res.status(400).json({ error: "unit_cost_cents must be >= 0" });
  }

  const poBody = {
    vendor_id: vendorId,
    brand_id: build.brand_id || undefined,
    po_type: "made_to_order",
    notes: `Conversion PO for build ${build.build_number} (${mode}).`,
    lines: [{
      inventory_item_id: build.finished_item_id || null,
      description: `CMT: ${build.build_number}`,
      qty_ordered: qty,
      unit_cost_cents: unitCostCents,
    }],
  };

  const { statusCode, payload } = await createDraftPo(poBody);
  if (statusCode >= 400 || !payload || !payload.id) {
    return res.status(statusCode >= 400 ? statusCode : 500).json({ error: (payload && payload.error) || "Failed to create conversion PO." });
  }

  // Stamp the build with the PO + chosen GL mode.
  const { error: upErr } = await admin.from("mfg_build_orders")
    .update({ conversion_po_id: payload.id, conversion_po_mode: mode, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (upErr) {
    return res.status(500).json({ error: `Conversion PO ${payload.id} created but failed to link it to the build: ${upErr.message}` });
  }

  return res.status(201).json({
    build_order_id: id,
    conversion_po_id: payload.id,
    conversion_po_mode: mode,
    purchase_order: {
      id: payload.id, po_number: payload.po_number || null, status: payload.status,
      vendor_id: payload.vendor_id, total_cents: payload.total_cents,
    },
    message: `Conversion PO created (draft) for build ${build.build_number} — ${mode} mode.`,
  });
}
