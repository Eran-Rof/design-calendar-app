// api/internal/costing/lines/:line_id
//
// GET    — single line detail
// PUT    — patch line (editable cost/margin/metadata columns)
// DELETE — remove line (cascades to quotes + compliance)

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../../_lib/auth.js";
import { vendorTargetForMode } from "../../../../../_lib/costingVendorTarget.js";
import { diffVendorFields } from "../../../../../_lib/rfqLineRevision.js";

export const config = { maxDuration: 15 };

const EDITABLE = [
  "sort_order",
  "style_master_id", "style_code", "style_name", "description", "picture_url",
  "size_scale_id", "size_scale_label", "fabric_code", "fabric_codes", "fit", "color",
  "bottom_closure", "waist_type", "waste_type",
  "category_id", "sub_category_id", "style_state",
  "comment", "remarks",
  "status",
  "target_qty", "target_cost", "avg_cost", "sell_target", "sell_price",
  "priced_date", "fob_cost", "duty_rate", "freight", "insurance", "other_costs",
  "landed_cost", "margin_pct",
  "selected_vendor_quote_id",
  "ly_qty", "ly_unit_cost", "ly_unit_price", "ly_total_margin", "ly_margin_pct",
  "t3_qty", "t3_unit_cost", "t3_unit_price", "t3_total_cost", "t3_margin_pct",
  "comp_refreshed_at",
];

function getLineId(req) {
  if (req.query && req.query.line_id) return req.query.line_id;
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("lines");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const lineId = getLineId(req);
  if (!lineId) return res.status(400).json({ error: "Missing line id" });

  if (req.method === "GET") {
    const { data, error } = await admin.from("costing_lines").select("*").eq("id", lineId).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Line not found" });
    return res.status(200).json(data);
  }

  if (req.method === "PUT") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const updates = {};
    for (const f of EDITABLE) {
      if (body && Object.prototype.hasOwnProperty.call(body, f)) updates[f] = body[f];
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No editable fields in body" });

    const { data, error } = await admin.from("costing_lines")
      .update(updates).eq("id", lineId).select("*").maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Line not found" });

    // When the buyer edits a costing line that's already been sent to a vendor,
    // re-sync the vendor-visible fields onto the linked rfq_line_items, stamp
    // which fields changed (revised_at + revised_fields → the portal flags the
    // line "Revised" + green-highlights those cells), and notify the vendor.
    // The vendor target is the cost they quote against — Tgt DDP cost (DDP) or
    // FOB cost (FOB/Landed) — NEVER the sell price.
    //
    // revisionSummary is returned to the costing UI (as `_rfq_revision`) so it
    // can show an on-screen "RFQ revised & sent to <vendor>" confirmation.
    let revisionSummary = null;
    try {
      const ATTR_FIELDS = ["fabric_code", "fit", "bottom_closure", "size_scale_label", "waist_type", "style_code", "color"];
      const costChanged = "target_cost" in updates || "fob_cost" in updates;
      const qtyChanged  = "target_qty" in updates;
      const attrChanged = ATTR_FIELDS.some(f => f in updates);

      if ((costChanged || qtyChanged || attrChanged) && data.project_id) {
        // Cost mode (DDP vs FOB) from the project's payment terms.
        let isDdp = false;
        try {
          const { data: proj } = await admin.from("costing_projects")
            .select("payment_terms_name").eq("id", data.project_id).maybeSingle();
          isDdp = !!proj?.payment_terms_name && /DDP/i.test(proj.payment_terms_name);
        } catch { /* default to FOB basis */ }

        // The new vendor-visible values — only for fields this edit touched.
        const next = {};
        if (costChanged) {
          const tp = vendorTargetForMode(isDdp, data.target_cost, data.fob_cost);
          if (tp !== null) next.target_price = tp;
        }
        if (qtyChanged) next.quantity = Math.max(1, Math.round(Number(data.target_qty) || 1));
        for (const f of ATTR_FIELDS) if (f in updates) next[f] = data[f] || null;

        if (Object.keys(next).length > 0) {
          const nowIso = new Date().toISOString();
          const selectCols = ["id", "rfq_id", ...Object.keys(next)].join(", ");

          // Path A — FK-linked lines (RFQs generated after migration 20260719000000):
          // full diff + revision flags + history snapshot + notify.
          const { data: items } = await admin.from("rfq_line_items").select(selectCols).eq("costing_line_id", lineId);
          const changedRfqIds = new Set();
          const allChangedFields = new Set();
          for (const it of items || []) {
            const changed = diffVendorFields(it, next, Object.keys(next));
            if (changed.length === 0) continue;
            const patch = { revised_at: nowIso, revised_fields: changed };
            for (const f of changed) patch[f] = next[f];
            await admin.from("rfq_line_items").update(patch).eq("id", it.id);
            changedRfqIds.add(it.rfq_id);
            changed.forEach((f) => allChangedFields.add(f));

            // Caveat 2 — append-only ROF revision history snapshot (old → new).
            // Best-effort: a missing table / insert error never blocks the save.
            try {
              await admin.from("rfq_line_revisions").insert({
                rfq_line_item_id: it.id,
                rfq_id: it.rfq_id,
                costing_line_id: lineId,
                revised_at: nowIso,
                changed_fields: changed,
                old_values: Object.fromEntries(changed.map((f) => [f, it[f] ?? null])),
                new_values: Object.fromEntries(changed.map((f) => [f, next[f] ?? null])),
                revised_by: "ROF",
                entity_id: data.entity_id || null,
              });
            } catch { /* history is best-effort */ }
          }

          // Path B — legacy FK-less rows: keep the target_price-only sync (no
          // revision flags; they predate the costing_line_id back-pointer).
          if (costChanged && next.target_price != null) {
            const toNum = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
            const { data: rfqRows } = await admin.from("rfqs")
              .select("id").eq("source_costing_project_id", data.project_id);
            const rfqIds = (rfqRows || []).map(r => r.id);
            if (rfqIds.length > 0) {
              const { data: legItems } = await admin.from("rfq_line_items")
                .select("id, target_price").in("rfq_id", rfqIds).is("costing_line_id", null);
              const oldRef = toNum(data.target_cost);
              const legIds = (legItems || [])
                .filter(i => oldRef === null || toNum(i.target_price) === oldRef)
                .map(i => i.id);
              if (legIds.length > 0) {
                await admin.from("rfq_line_items").update({ target_price: next.target_price }).in("id", legIds);
              }
            }
          }

          // Notify the invited vendor(s) of every RFQ whose line(s) changed,
          // and build the ROF-side on-screen confirmation summary.
          if (changedRfqIds.size > 0) {
            const ids = Array.from(changedRfqIds);
            const { data: rfqMeta } = await admin.from("rfqs").select("id, title").in("id", ids);
            const titleById = Object.fromEntries((rfqMeta || []).map(r => [r.id, r.title]));
            const { data: invs } = await admin.from("rfq_invitations").select("rfq_id, vendor_id").in("rfq_id", ids);

            // Resolve vendor display names for the confirmation message.
            const vendorIds = [...new Set((invs || []).map(i => i.vendor_id).filter(Boolean))];
            let nameByVendor = {};
            if (vendorIds.length > 0) {
              const { data: vrows } = await admin.from("vendors")
                .select("id, legal_name, name, code").in("id", vendorIds);
              nameByVendor = Object.fromEntries((vrows || []).map(v =>
                [v.id, v.legal_name || v.name || v.code || "vendor"]));
            }

            const origin = `https://${req.headers.host}`;
            await Promise.all((invs || []).map((inv) =>
              fetch(`${origin}/api/send-notification`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  event_type: "rfq_revised",
                  title: `An RFQ was revised: ${titleById[inv.rfq_id] || "RFQ"}`,
                  body: "Ring of Fire updated this RFQ. Open it to review the changed details (highlighted in green).",
                  link: `/vendor/rfqs/${inv.rfq_id}`,
                  metadata: { rfq_id: inv.rfq_id },
                  recipient: { vendor_id: inv.vendor_id },
                  // Keyed by this revision's timestamp so each distinct revision notifies.
                  dedupe_key: `rfq_revised_${inv.rfq_id}_${inv.vendor_id}_${nowIso}`,
                  email: true,
                }),
              }).catch(() => {})
            ));

            // Human-friendly labels for the changed vendor-visible fields.
            const FIELD_LABELS = {
              target_price: "target cost", quantity: "quantity", fabric_code: "fabric",
              fit: "fit", bottom_closure: "closure", size_scale_label: "size scale",
              waist_type: "waist", style_code: "style", color: "color",
            };
            const vendorNames = [...new Set(vendorIds.map(id => nameByVendor[id]).filter(Boolean))];
            revisionSummary = {
              rfqs: ids.map(rid => ({
                id: rid,
                title: titleById[rid] || "RFQ",
                vendors: (invs || []).filter(i => i.rfq_id === rid)
                  .map(i => nameByVendor[i.vendor_id]).filter(Boolean),
              })),
              vendors: vendorNames,
              fields: [...allChangedFields].map(f => FIELD_LABELS[f] || f),
            };
          }
        }
      }
    } catch (e) {
      // Best-effort: never fail the costing-line save on a sync/notify hiccup.
      console.warn(`[costing-line] RFQ revision sync failed for line ${lineId}: ${e && e.message ? e.message : String(e)}`);
    }

    // Attach the revision summary (null when nothing was sent to a vendor) so the
    // costing UI can surface "RFQ revised & sent to <vendor>". Non-enumerable-ish
    // extra key on the line payload — the frontend strips it before storing.
    return res.status(200).json(revisionSummary ? { ...data, _rfq_revision: revisionSummary } : data);
  }

  if (req.method === "DELETE") {
    const { error } = await admin.from("costing_lines").delete().eq("id", lineId);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(204).end();
  }

  return res.status(405).json({ error: "Method not allowed" });
}
