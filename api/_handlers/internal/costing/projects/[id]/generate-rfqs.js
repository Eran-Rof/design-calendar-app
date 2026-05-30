// api/internal/costing/projects/:id/generate-rfqs
//
// POST { line_ids: string[] }
//
// Generates one RFQ per unique vendor selected across the given costing
// lines. Lines without a selected vendor are skipped (reported back in
// `skipped_no_vendor` for the toast).
//
// Per-vendor grouping: every line whose currently-selected quote points
// at vendor X becomes a single rfq_line_item under the RFQ created for
// vendor X. So if 5 selected lines map to 2 vendors (3 to HEMAYET, 2 to
// CHEUK), this handler creates 2 RFQs with 3 + 2 line items respectively.
//
// Created records:
//   • rfqs                — header (title auto-generated from project + vendor)
//   • rfq_line_items      — one per costing_line in the vendor group
//   • rfq_invitations     — one row per RFQ targeting the single vendor
//
// We use the existing Tangerine procurement RFQ schema (phase8) since it
// already has the right shape — header / lines / invitations.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../../_lib/auth.js";

export const config = { maxDuration: 30 };

function getProjectId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("projects");
  return idx >= 0 ? parts[idx + 1] : null;
}

async function resolveEntityId(admin, req) {
  // Same pattern as the other costing inserts (PR #556): trust X-Entity-ID
  // header → fall back to first entity in entities table. RLS prevents
  // cross-entity reads regardless.
  const headerId = req.headers["x-entity-id"];
  if (headerId && typeof headerId === "string") return headerId.trim();
  const { data } = await admin.from("entities").select("id").limit(1).maybeSingle();
  return data?.id || null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const projectId = getProjectId(req);
  if (!projectId) return res.status(400).json({ error: "Missing project id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const lineIds = Array.isArray(body?.line_ids) ? body.line_ids.filter((s) => typeof s === "string" && s.length > 0) : [];
  if (lineIds.length === 0) return res.status(400).json({ error: "line_ids[] is required and must be non-empty" });

  // 1. Project (for title + currency + due date defaults).
  const { data: project, error: projectErr } = await admin.from("costing_projects")
    .select("id, project_name, brand, due_date, currency")
    .eq("id", projectId).maybeSingle();
  if (projectErr) return res.status(500).json({ error: projectErr.message });
  if (!project) return res.status(404).json({ error: "Project not found" });

  const entityId = await resolveEntityId(admin, req);
  if (!entityId) return res.status(500).json({ error: "Could not resolve entity_id" });

  // 2. Lines + their selected vendor (the picker writes a costing_line_vendors
  //    row with status='selected' and stamps costing_lines.selected_vendor_quote_id).
  const { data: lines, error: linesErr } = await admin.from("costing_lines")
    .select("id, style_code, style_name, description, color, size_scale_label, fabric_code, comment, remarks, target_qty, target_cost, selected_vendor_quote_id")
    .eq("project_id", projectId)
    .in("id", lineIds);
  if (linesErr) return res.status(500).json({ error: linesErr.message });

  const skippedNoVendor = [];
  const linesWithQuote = [];
  for (const ln of lines || []) {
    if (!ln.selected_vendor_quote_id) skippedNoVendor.push(ln.id);
    else linesWithQuote.push(ln);
  }

  if (linesWithQuote.length === 0) {
    return res.status(200).json({
      created: [],
      skipped_no_vendor: skippedNoVendor,
      message: "No lines have a selected vendor. Pick a vendor on each row first.",
    });
  }

  // 3. Resolve vendor_id for each selected quote in one query.
  const quoteIds = linesWithQuote.map((l) => l.selected_vendor_quote_id);
  const { data: quotes, error: quotesErr } = await admin.from("costing_line_vendors")
    .select("id, vendor_id")
    .in("id", quoteIds);
  if (quotesErr) return res.status(500).json({ error: quotesErr.message });
  const vendorByQuote = Object.fromEntries((quotes || []).map((q) => [q.id, q.vendor_id]));

  // 4. Group lines by vendor.
  const linesByVendor = new Map(); // vendor_id → [line, ...]
  for (const ln of linesWithQuote) {
    const vid = vendorByQuote[ln.selected_vendor_quote_id];
    if (!vid) { skippedNoVendor.push(ln.id); continue; }
    if (!linesByVendor.has(vid)) linesByVendor.set(vid, []);
    linesByVendor.get(vid).push(ln);
  }

  if (linesByVendor.size === 0) {
    return res.status(200).json({
      created: [],
      skipped_no_vendor: skippedNoVendor,
      message: "Selected lines had no resolvable vendor (quotes deleted or vendor unset).",
    });
  }

  // 5. Look up vendor display names for the response toast.
  const { data: vendorRows } = await admin.from("vendors")
    .select("id, code, legal_name")
    .in("id", Array.from(linesByVendor.keys()));
  const vendorById = Object.fromEntries((vendorRows || []).map((v) => [v.id, v]));

  // 6. For each vendor group, create rfqs + rfq_line_items + rfq_invitation.
  // Sequential to keep errors localized; Vercel maxDuration covers typical
  // grids (< 30 lines, < 5 vendors).
  const created = [];
  const errors = [];

  for (const [vendorId, vendorLines] of linesByVendor.entries()) {
    const vendor = vendorById[vendorId];
    const vendorLabel = vendor?.legal_name || vendor?.code || "Vendor";
    const title = `${project.project_name} — ${vendorLabel}`;
    const totalQty = vendorLines.reduce((s, l) => s + (Number(l.target_qty) || 0), 0);
    const totalBudget = vendorLines.reduce((s, l) => s + (Number(l.target_qty) || 0) * (Number(l.target_cost) || 0), 0);

    const { data: rfq, error: rfqErr } = await admin.from("rfqs").insert({
      entity_id: entityId,
      title,
      description: `RFQ generated from costing project "${project.project_name}" (${vendorLines.length} line${vendorLines.length === 1 ? "" : "s"}).`,
      category: project.brand || null,
      status: "draft",
      delivery_required_by: project.due_date || null,
      estimated_quantity: Math.round(totalQty) || null,
      estimated_budget: Number.isFinite(totalBudget) && totalBudget > 0 ? totalBudget : null,
      currency: project.currency || "USD",
      created_by: "costing_module",
    }).select("id").maybeSingle();

    if (rfqErr || !rfq) {
      errors.push({ vendor_id: vendorId, vendor: vendorLabel, error: rfqErr?.message || "rfqs insert returned no row" });
      continue;
    }

    // rfq_line_items: one per costing line. quantity is integer; round
    // target_qty since costing_lines.target_qty is numeric(12,2).
    const itemRows = vendorLines.map((ln, idx) => {
      const parts = [
        ln.style_code,
        ln.color,
        ln.size_scale_label,
        ln.fabric_code,
      ].filter(Boolean);
      const descriptionMain = ln.description || ln.style_name || "(no description)";
      const description = parts.length > 0 ? `${parts.join(" · ")} — ${descriptionMain}` : descriptionMain;
      const specsParts = [
        ln.comment ? `Comment: ${ln.comment}` : null,
        ln.remarks ? `Remarks: ${ln.remarks}` : null,
        typeof ln.target_cost === "number" ? `Target cost: $${ln.target_cost.toFixed(2)}` : null,
      ].filter(Boolean);
      return {
        rfq_id: rfq.id,
        line_index: idx + 1,
        description,
        quantity: Math.max(1, Math.round(Number(ln.target_qty) || 1)),
        unit_of_measure: "ea",
        specifications: specsParts.length > 0 ? specsParts.join(" · ") : null,
      };
    });

    const { error: itemsErr } = await admin.from("rfq_line_items").insert(itemRows);
    if (itemsErr) {
      errors.push({ vendor_id: vendorId, vendor: vendorLabel, error: `line_items insert failed: ${itemsErr.message}` });
      // Don't bail — still create the invitation so the RFQ is at least
      // visible. Operator can re-run if line_items are missing.
    }

    const { error: inviteErr } = await admin.from("rfq_invitations").insert({
      rfq_id: rfq.id,
      vendor_id: vendorId,
      status: "invited",
    });
    if (inviteErr) {
      errors.push({ vendor_id: vendorId, vendor: vendorLabel, error: `invitation insert failed: ${inviteErr.message}` });
    }

    created.push({
      rfq_id: rfq.id,
      vendor_id: vendorId,
      vendor: vendorLabel,
      line_count: vendorLines.length,
      total_qty: totalQty,
    });
  }

  return res.status(200).json({
    created,
    skipped_no_vendor: skippedNoVendor,
    errors,
  });
}
