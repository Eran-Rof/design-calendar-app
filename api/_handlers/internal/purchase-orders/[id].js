// api/internal/purchase-orders/:id
//
// P16 / M11.
// GET    → header + lines.
// PATCH  → update mutable header fields, replace lines (drafts only), and/or
//          change status. Issuing (status → 'issued') assigns the immutable
//          po_number (PO-YYYY-NNNNN) if not already set.
// DELETE → only a draft PO (cascades lines).
//
// Status flow: draft → issued → in_transit → received → cancelled.

import { createClient } from "@supabase/supabase-js";
import { normalizeHeader } from "./index.js";
import { notifyVendor } from "../../../_lib/phase-notifications.js";
import { seedProvisionalForPo } from "../../../_lib/pricing/provisionalPrices.js";
import { resolveProductionManager } from "../../../_lib/internal-recipients.js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ["draft", "issued", "in_transit", "received", "cancelled"];

function extractPpk(v) {
  if (!v) return null;
  const m = String(v).match(/PPK[\s_-]*(\d+)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Roll up total weight / cartons / CBM for a PO's lines from the styles' Style
// Master logistics. PPK sizes carry the carton size in the size token (PPK<N>):
// the line qty IS cartons, units = qty × N. Non-PPK: line qty IS units, cartons
// = ceil(total units / units_per_carton) computed once per style.
async function computeLogisticsRollup(admin, lines) {
  const itemIds = [...new Set(lines.map((l) => l.inventory_item_id).filter(Boolean))];
  if (itemIds.length === 0) return { weight_kg: 0, cartons: 0, cbm_m3: 0, complete: true };
  const { data: items } = await admin.from("ip_item_master").select("id, style_code, size").in("id", itemIds);
  const itemById = new Map((items || []).map((i) => [i.id, i]));
  const codes = [...new Set((items || []).map((i) => i.style_code).filter(Boolean))];
  const { data: styles } = codes.length
    ? await admin.from("style_master").select("style_code, unit_weight_kg, units_per_carton, carton_cbm_m3").in("style_code", codes)
    : { data: [] };
  const styleByCode = new Map((styles || []).map((s) => [s.style_code, s]));

  // Accumulate per style so non-PPK cartons round once over the whole-style unit
  // total. PPK and non-PPK units are tracked SEPARATELY: a PPK line's qty is its
  // own carton count (qty × pack-size = units), while non-PPK qty is loose units
  // that pack into cartons of units_per_carton. A style can carry both (packs +
  // loose eaches), so the two carton contributions are ADDED, not chosen between.
  const byStyle = new Map();
  let complete = true;
  for (const l of lines) {
    const it = l.inventory_item_id ? itemById.get(l.inventory_item_id) : null;
    if (!it || !it.style_code) { complete = false; continue; }
    const st = styleByCode.get(it.style_code) || {};
    const per = extractPpk(it.size) || extractPpk(it.style_code);
    // Only treat as PPK for carton math when we could actually parse a pack size;
    // a "PPK" token with no number (no `per`) falls through to the loose-eaches
    // path so we don't count one carton per single unit.
    const isPpk = !!per && (/PPK/i.test(it.size || "") || /PPK/i.test(it.style_code || ""));
    const qty = Number(l.qty_ordered) || 0;
    const units = isPpk ? qty * per : qty;
    const acc = byStyle.get(it.style_code) || { uw: Number(st.unit_weight_kg) || 0, upc: Number(st.units_per_carton) || 0, cbm: Number(st.carton_cbm_m3) || 0, units: 0, ppkUnits: 0, nonPpkUnits: 0, ppkCartons: 0 };
    acc.units += units;
    if (isPpk) { acc.ppkUnits += units; acc.ppkCartons += qty; } else acc.nonPpkUnits += qty;
    byStyle.set(it.style_code, acc);
  }
  let weight = 0, cartons = 0, cbm = 0;
  for (const a of byStyle.values()) {
    const nonPpkCartons = a.upc > 0 ? Math.ceil(a.nonPpkUnits / a.upc) : 0;
    const styleCartons = a.ppkCartons + nonPpkCartons;
    // The roll-up is only "complete" if every field needed to compute it is set:
    // weight needs unit_weight_kg; loose units need units_per_carton to form
    // cartons; CBM needs carton_cbm_m3. Flag (don't silently drop) when missing.
    if (a.uw <= 0 || a.cbm <= 0) complete = false;
    if (a.nonPpkUnits > 0 && a.upc <= 0) complete = false;
    weight += a.units * a.uw;
    cartons += styleCartons;
    cbm += styleCartons * a.cbm;
  }
  return { weight_kg: Math.round(weight * 1000) / 1000, cartons, cbm_m3: Math.round(cbm * 100000) / 100000, complete };
}

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

async function nextPoNumber(admin, entityId, year, rawPrefix) {
  // Editable prefix (operator): sanitize to A–Z/0–9/-, fall back to 'PO'.
  const base = (String(rawPrefix || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "") || "PO");
  const prefix = `${base}-${year}-`;
  const { count } = await admin.from("purchase_orders")
    .select("id", { count: "exact", head: true })
    .eq("entity_id", entityId)
    .ilike("po_number", `${prefix}%`);
  return `${prefix}${String((count || 0) + 1).padStart(5, "0")}`;
}

export default async function handler(req, res, params) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const id = params?.id || req.query?.id;
  if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: "Invalid id" });
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: po, error: poErr } = await admin.from("purchase_orders").select("*").eq("id", id).maybeSingle();
  if (poErr) return res.status(500).json({ error: poErr.message });
  if (!po) return res.status(404).json({ error: "Purchase order not found" });

  if (req.method === "GET") {
    const { data: lines, error: lErr } = await admin.from("purchase_order_lines")
      .select("*").eq("purchase_order_id", id).order("line_number", { ascending: true });
    if (lErr) return res.status(500).json({ error: lErr.message });
    // Decorate each line with its SKU decomposition so the PO modal regroups
    // lines into the per-style size matrix on edit (mirrors the SO detail).
    const itemIds = [...new Set((lines || []).map((l) => l.inventory_item_id).filter(Boolean))];
    let skuById = new Map();
    if (itemIds.length) {
      const { data: skus } = await admin.from("ip_item_master").select("id, style_code, color, size, inseam, sku_code").in("id", itemIds);
      skuById = new Map((skus || []).map((s) => [s.id, s]));
    }
    // Manufacturing-part lines (part_id set) — decorate with the part code/name so
    // the PO modal + Receiving show a label instead of a bare id.
    const partIds = [...new Set((lines || []).map((l) => l.part_id).filter(Boolean))];
    let partById = new Map();
    if (partIds.length) {
      // Include parent_part_id + size so a matrix part's per-size CHILD lines can
      // regroup into a by-size matrix row on edit.
      const { data: parts } = await admin.from("part_master").select("id, code, name, uom, parent_part_id, size").in("id", partIds);
      partById = new Map((parts || []).map((p) => [p.id, p]));
    }
    const decorated = (lines || []).map((l) => {
      const s = l.inventory_item_id ? skuById.get(l.inventory_item_id) : null;
      const p = l.part_id ? partById.get(l.part_id) : null;
      return { ...l, style_code: s?.style_code ?? null, color: s?.color ?? null, size: s?.size ?? null, inseam: s?.inseam ?? null, sku_code: s?.sku_code ?? null,
        part_code: p?.code ?? null, part_name: p?.name ?? null, part_uom: p?.uom ?? null,
        part_parent_id: p?.parent_part_id ?? null, part_size: p?.size ?? null };
    });
    const rollup = await computeLogisticsRollup(admin, lines || []);
    // When this PO is awaiting production approval, tell the client who may act
    // on it, so the Approve/Reject controls show only for the Production Manager
    // (the server still enforces this on the decision itself).
    let production_manager_emails;
    if (po.requires_production_approval && po.production_approval_status === "pending") {
      try {
        const pm = await resolveProductionManager(admin);
        production_manager_emails = pm.emails || [];
      } catch { production_manager_emails = []; }
    }
    return res.status(200).json({ ...po, lines: decorated, logistics_rollup: rollup, production_manager_emails });
  }

  if (req.method === "DELETE") {
    if (po.status !== "draft") return res.status(409).json({ error: "Only a draft purchase order can be deleted (cancel an issued one instead)." });
    const { error } = await admin.from("purchase_orders").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    body = body || {};

    // ── Production-Manager approval decision (approve / reject) ──────────────
    // Folded into PATCH as a dedicated verb so it needs no separate route.
    // Authorized to the resolved Production Manager (by caller email), which is
    // independent of general PO-edit access.
    if (body.production_decision === "approve" || body.production_decision === "reject") {
      const decision = body.production_decision;
      if (!po.requires_production_approval) {
        return res.status(409).json({ error: "This purchase order does not require production approval." });
      }
      if (po.production_approval_status !== "pending") {
        return res.status(409).json({ error: `This purchase order is already ${po.production_approval_status}.` });
      }
      const note = (body.production_note || "").toString().trim();
      if (decision === "reject" && !note) {
        return res.status(400).json({ error: "A reason is required to reject a purchase order." });
      }
      const caller = (req.headers["x-user-email"] || "").toString().trim().toLowerCase();
      const pm = await resolveProductionManager(admin);
      const pmEmails = (pm.emails || []).map((e) => e.toLowerCase());
      // Fail-open ONLY when no Production Manager is configured (so a mis-set
      // title can't permanently brick issuing); otherwise the caller must be it.
      if (pmEmails.length > 0 && (!caller || !pmEmails.includes(caller))) {
        return res.status(403).json({ error: "Only the Production Manager can approve or reject this purchase order." });
      }
      const nowIso = new Date().toISOString();
      const { data: decided, error: dErr } = await admin.from("purchase_orders").update({
        production_approval_status: decision === "approve" ? "approved" : "rejected",
        production_approval_by: caller || null,
        production_approval_at: nowIso,
        production_approval_note: note || null,
      }).eq("id", id).select("*").single();
      if (dErr) return res.status(500).json({ error: dErr.message });

      // Notify the planner who pushed the PO of the outcome (best-effort).
      if (po.production_requested_by) {
        const origin = req.headers.origin || (req.headers.host ? `https://${req.headers.host}` : null);
        const label = decided.po_number || `draft ${String(id).slice(0, 8)}`;
        try {
          await fetch(`${origin}/api/send-notification`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              event_type: `po_production_${decision === "approve" ? "approved" : "rejected"}`,
              title: `Purchase order ${label} ${decision === "approve" ? "approved" : "rejected"}`,
              body: decision === "approve"
                ? `Your planning purchase order ${label} was approved by the Production Manager and can now be issued.`
                : `Your planning purchase order ${label} was rejected by the Production Manager. Reason: ${note}`,
              link: "/tangerine?m=purchase_orders",
              metadata: { po_id: id, po_number: decided.po_number || null, decision },
              recipient: { email: po.production_requested_by },
              email: true,
              dedupe_key: `po_production_${decision}_${id}`,
            }),
          });
        } catch { /* non-blocking */ }
      }
      return res.status(200).json(decided);
    }

    const patch = {};
    const nz = (k) => (body[k] && UUID_RE.test(String(body[k])) ? body[k] : null);
    for (const k of ["brand_id", "payment_terms_id"]) {
      if (k in body) patch[k] = nz(k);
    }
    if ("vendor_id" in body) {
      if (!UUID_RE.test(String(body.vendor_id))) return res.status(400).json({ error: "vendor_id must be a uuid" });
      patch.vendor_id = body.vendor_id;
    }
    for (const k of ["order_date", "expected_date"]) {
      if (k in body) patch[k] = /^\d{4}-\d{2}-\d{2}$/.test(body[k] || "") ? body[k] : null;
    }
    if ("notes" in body) patch.notes = body.notes ? String(body.notes).trim() : null;

    // Rich-header fields — only patch the ones actually present in the body.
    const hn = normalizeHeader(body);
    for (const k of Object.keys(hn)) {
      if (k in body) patch[k] = hn[k];
    }

    if ("status" in body) {
      if (!STATUSES.includes(body.status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}` });
      // 'received' is not a manual flag — it's set only when a goods receipt is
      // POSTED (procurement/receipts/:id/post rolls qty_received + flips the
      // header). Reject a direct manual flip so the status always reflects a
      // real, GL'd receipt. (in_transit stays a manual logistics flag.)
      if (body.status === "received" && po.status !== "received") {
        return res.status(409).json({ error: "Mark a PO received by posting a goods receipt in Receiving — not by a manual status change." });
      }
      // Planning-pushed POs can't be issued until the Production Manager signs
      // off (see the buy-plan-to-po push + the production_decision branch above).
      if (body.status === "issued" && po.status === "draft"
          && po.requires_production_approval && po.production_approval_status !== "approved") {
        return res.status(409).json({
          error: po.production_approval_status === "rejected"
            ? "This planning purchase order was rejected by the Production Manager and can't be issued — revisit it in the planning buy plan."
            : "This planning purchase order needs Production Manager approval before it can be issued.",
        });
      }
      patch.status = body.status;
      // Assign the immutable PO number when first issued (po_number is immutable once set).
      if (body.status === "issued" && !po.po_number) {
        const year = (po.order_date || new Date().toISOString().slice(0, 10)).slice(0, 4);
        // Use the (possibly just-patched) editable prefix, else the stored one.
        const prefix = ("po_prefix" in patch ? patch.po_prefix : po.po_prefix);
        patch.po_number = await nextPoNumber(admin, po.entity_id, year, prefix);
      }
    }

    // Replace lines if supplied. Drafts edit freely; an issued/in-transit/received
    // PO is line-locked UNLESS this is an explicit revision (revise:true) — the
    // operator's "✎ Edit" path, which also notifies the vendor below.
    const isRevision = body.revise === true && po.status !== "cancelled";
    let revisionLinesChanged = false;
    let revisionOrphanedConsumedCents = 0;
    if (Array.isArray(body.lines)) {
      if (po.status !== "draft" && !("status" in body) && !isRevision) {
        return res.status(409).json({ error: "Lines can only be edited on a draft, or via an explicit revision." });
      }
      const norm = [];
      let ln = 1;
      for (const l of body.lines) {
        const qty = Number(l.qty_ordered);
        if (!Number.isFinite(qty) || qty <= 0) continue;
        const unit = l.unit_cost_cents == null || l.unit_cost_cents === "" ? 0 : Math.round(Number(l.unit_cost_cents));
        const dre = /^\d{4}-\d{2}-\d{2}$/;
        norm.push({
          purchase_order_id: id, line_number: ln++,
          inventory_item_id: l.inventory_item_id && UUID_RE.test(String(l.inventory_item_id)) ? l.inventory_item_id : null,
          part_id: l.part_id && UUID_RE.test(String(l.part_id)) ? l.part_id : null,
          description: l.description ? String(l.description).trim() : null,
          qty_ordered: qty, unit_cost_cents: unit, line_total_cents: Math.round(qty * unit),
          requested_ship_date: dre.test(l.requested_ship_date || "") ? l.requested_ship_date : null,
          vendor_confirmed_ship_date: dre.test(l.vendor_confirmed_ship_date || "") ? l.vendor_confirmed_ship_date : null,
          lot_number: l.lot_number != null && String(l.lot_number).trim() !== "" ? String(l.lot_number).trim() : null,
        });
      }
      if (po.status === "draft") {
        // Drafts edit freely — nothing references draft lines yet.
        await admin.from("purchase_order_lines").delete().eq("purchase_order_id", id);
        if (norm.length) {
          const { error: lErr } = await admin.from("purchase_order_lines").insert(norm);
          if (lErr) return res.status(500).json({ error: `Line update failed: ${lErr.message}` });
        }
      } else {
        // Diff-based replacement for issued/in-transit/received POs — the line ids
        // must survive a revision: tanda_po_receipt_lines FKs RESTRICT (wholesale
        // delete 500s on any received PO) and po_commitments / po_shipment_lines
        // CASCADE (wholesale delete silently wiped D3 commitments + the in-transit
        // overlay). Match incoming lines to existing ones by item/part.
        const { data: existing, error: exErr } = await admin.from("purchase_order_lines")
          .select("id, inventory_item_id, part_id, line_number, qty_received")
          .eq("purchase_order_id", id)
          .order("line_number", { ascending: true });
        if (exErr) return res.status(500).json({ error: `Line read failed: ${exErr.message}` });
        const keyOf = (l) => `${l.inventory_item_id || ""}|${l.part_id || ""}`;
        const pool = new Map();
        for (const ex of existing || []) {
          if (!pool.has(keyOf(ex))) pool.set(keyOf(ex), []);
          pool.get(keyOf(ex)).push(ex);
        }
        const updates = [];
        const inserts = [];
        for (const n of norm) {
          const match = (pool.get(keyOf(n)) || []).shift();
          if (match) {
            const { line_number: _ln, purchase_order_id: _po, ...fields } = n;
            updates.push({ id: match.id, fields, received: Number(match.qty_received) || 0, inventory_item_id: match.inventory_item_id || null });
          } else {
            inserts.push(n);
          }
        }
        // Guard: a revision must never drop a kept line's ordered quantity below
        // what's already been received (that would produce an impossible negative
        // remaining / over-received line). The UI restricts editing to the
        // remain-to-ship on received POs, but the API is the authoritative check.
        const violations = updates.filter((u) => u.received > 0 && Number(u.fields.qty_ordered) < u.received);
        if (violations.length) {
          const vItemIds = [...new Set(violations.map((v) => v.inventory_item_id).filter(Boolean))];
          let byId = new Map();
          if (vItemIds.length) {
            const { data: skus } = await admin.from("ip_item_master").select("id, sku_code, style_code, color, size").in("id", vItemIds);
            byId = new Map((skus || []).map((s) => [s.id, s]));
          }
          const detail = violations.map((v) => {
            const s = v.inventory_item_id ? byId.get(v.inventory_item_id) : null;
            const name = s ? (`${s.style_code || ""} ${s.color || ""} ${s.size || ""}`.replace(/\s+/g, " ").trim() || s.sku_code || "a line") : "a line";
            return `${name} (ordered ${Number(v.fields.qty_ordered)} < received ${v.received})`;
          }).join("; ");
          return res.status(409).json({ error: `A revision can't reduce a line's ordered quantity below what's already been received: ${detail}. Adjust the remaining-to-ship quantity instead.` });
        }
        const removed = [...pool.values()].flat();
        if (removed.length) {
          const removedIds = removed.map((l) => l.id);
          const { data: rcptRefs } = await admin.from("tanda_po_receipt_lines")
            .select("purchase_order_line_id").in("purchase_order_line_id", removedIds).limit(1);
          if (rcptRefs && rcptRefs.length) {
            return res.status(409).json({ error: "A revision can't remove a line that already has receipts against it. Keep the line (adjust its quantity), or void the receipt first." });
          }
          // Receipt consumption rolls up oldest-first across the whole PO, so a
          // removed line's commitment may carry consumption that belongs to the
          // PO — capture it before the CASCADE delete and re-apply below.
          const { data: doomed } = await admin.from("po_commitments")
            .select("consumed_amount_cents").in("purchase_order_line_id", removedIds);
          revisionOrphanedConsumedCents = (doomed || [])
            .reduce((s, c) => s + (Number(c.consumed_amount_cents) || 0), 0);
          const { error: dErr } = await admin.from("purchase_order_lines").delete().in("id", removedIds);
          if (dErr) return res.status(500).json({ error: `Line removal failed: ${dErr.message}` });
        }
        for (const u of updates) {
          const { error: uErr } = await admin.from("purchase_order_lines").update(u.fields).eq("id", u.id);
          if (uErr) return res.status(500).json({ error: `Line update failed: ${uErr.message}` });
        }
        if (inserts.length) {
          let maxLn = (existing || []).reduce((m, l) => Math.max(m, Number(l.line_number) || 0), 0);
          const rows = inserts.map((n) => ({ ...n, line_number: ++maxLn }));
          const { error: iErr } = await admin.from("purchase_order_lines").insert(rows);
          if (iErr) return res.status(500).json({ error: `Line insert failed: ${iErr.message}` });
        }
        revisionLinesChanged = true;
      }
      const subtotal = norm.reduce((s, l) => s + l.line_total_cents, 0);
      patch.subtotal_cents = subtotal;
      patch.total_cents = subtotal;
    }

    if (Object.keys(patch).length === 0) return res.status(200).json(po);
    const { data, error } = await admin.from("purchase_orders").update(patch).eq("id", id).select("*").single();
    if (error) return res.status(500).json({ error: error.message });

    // Scenario 1 — at issue, stamp the PO number as the lot on every line that
    // doesn't already carry an operator-set lot. Runs after any line replacement
    // above so freshly-inserted lines are covered. Never overwrites a manual lot.
    if (body.status === "issued" && data.po_number) {
      await admin.from("purchase_order_lines")
        .update({ lot_number: data.po_number })
        .eq("purchase_order_id", id)
        .is("lot_number", null);
    }

    // P13/C0 — open-PO commitment tracking (off-balance-sheet, D3).
    // On first issue, record one po_commitments row per line; on cancel, close them;
    // on reinstate (cancelled → issued), re-open the ones this PO's cancel closed.
    if ("status" in body) {
      if (body.status === "issued" && po.status !== "issued") {
        const { count } = await admin.from("po_commitments")
          .select("id", { count: "exact", head: true }).eq("purchase_order_id", id);
        if (!count) {
          const { data: lines } = await admin.from("purchase_order_lines")
            .select("id, line_total_cents, qty_ordered").eq("purchase_order_id", id);
          const rows = (lines || [])
            .filter((l) => Number(l.qty_ordered) > 0)
            .map((l) => ({
              entity_id: data.entity_id, purchase_order_id: id, purchase_order_line_id: l.id,
              vendor_id: data.vendor_id, committed_amount_cents: Number(l.line_total_cents) || 0,
              status: "open", expected_in_dc_date: data.expected_date || null,
            }));
          if (rows.length) await admin.from("po_commitments").insert(rows);
        } else if (po.status === "cancelled") {
          // Reinstating a cancelled PO — restore the commitments its cancel closed
          // so the open-PO commitment (D3) reflects the live PO again. (A partially-
          // received PO reopened here returns to 'open', not 'partial' — rare edge.)
          await admin.from("po_commitments")
            .update({ status: "open", closed_at: null })
            .eq("purchase_order_id", id).eq("status", "cancelled");
        }
      } else if (body.status === "cancelled") {
        await admin.from("po_commitments")
          .update({ status: "cancelled", closed_at: new Date().toISOString() })
          .eq("purchase_order_id", id).in("status", ["open", "partial"]);
      }
    }

    // A revision that changed lines must keep the D3 open-PO commitments in sync
    // (the issue-time seed above only runs on the draft→issued transition).
    // Surviving lines keep their commitment row (amount refreshed, status
    // recomputed from consumption); brand-new lines get a fresh 'open' row;
    // removed lines' rows were CASCADE-deleted with the line, and any receipt
    // consumption stranded on them is re-applied oldest-first below.
    if (revisionLinesChanged) {
      const { data: commits } = await admin.from("po_commitments")
        .select("id, purchase_order_line_id, committed_amount_cents, consumed_amount_cents, status")
        .eq("purchase_order_id", id);
      const wasIssued = (commits || []).length > 0 || revisionOrphanedConsumedCents > 0;
      if (wasIssued) {
        const { data: curLines } = await admin.from("purchase_order_lines")
          .select("id, line_total_cents, qty_ordered").eq("purchase_order_id", id);
        const byLine = new Map((commits || []).map((c) => [c.purchase_order_line_id, c]));
        for (const l of curLines || []) {
          if (!(Number(l.qty_ordered) > 0)) continue;
          const committed = Number(l.line_total_cents) || 0;
          const c = byLine.get(l.id);
          if (c) {
            if (c.status === "cancelled") continue;
            const consumed = Number(c.consumed_amount_cents) || 0;
            const status = committed > 0 && consumed >= committed ? "closed" : consumed > 0 ? "partial" : "open";
            if (committed !== Number(c.committed_amount_cents) || status !== c.status) {
              await admin.from("po_commitments").update({
                committed_amount_cents: committed,
                status,
                closed_at: status === "closed" ? new Date().toISOString() : null,
              }).eq("id", c.id);
            }
          } else {
            await admin.from("po_commitments").insert({
              entity_id: data.entity_id, purchase_order_id: id, purchase_order_line_id: l.id,
              vendor_id: data.vendor_id, committed_amount_cents: committed,
              status: "open", expected_in_dc_date: data.expected_date || null,
            });
          }
        }
        if (revisionOrphanedConsumedCents > 0) {
          const { data: open2 } = await admin.from("po_commitments")
            .select("id, committed_amount_cents, consumed_amount_cents")
            .eq("purchase_order_id", id).in("status", ["open", "partial"])
            .order("created_at", { ascending: true });
          let remaining = revisionOrphanedConsumedCents;
          for (const c of open2 || []) {
            if (remaining <= 0) break;
            const room = Number(c.committed_amount_cents) - Number(c.consumed_amount_cents);
            if (room <= 0) continue;
            const apply = Math.min(room, remaining);
            const newConsumed = Number(c.consumed_amount_cents) + apply;
            const full = newConsumed >= Number(c.committed_amount_cents);
            await admin.from("po_commitments").update({
              consumed_amount_cents: newConsumed,
              status: full ? "closed" : "partial",
              closed_at: full ? new Date().toISOString() : null,
            }).eq("id", c.id);
            remaining -= apply;
          }
        }
      }
    }

    // Seed provisional selling prices for this PO's never-sold styles (21% margin
    // off the PO line cost) so the PO/SO grids show a Sell/Margin for them until a
    // real sale lands. Best-effort — never fails the issue.
    if (body.status === "issued" && po.status !== "issued") {
      try { await seedProvisionalForPo(admin, id); } catch { /* non-blocking */ }
    }

    // Revision of a saved PO → notify the vendor's portal users (bell + email).
    // Best-effort + no-op when the vendor has no portal users (notifyVendor → 0).
    let vendor_notified = 0;
    if (isRevision && po.status !== "draft") {
      const origin = req.headers.origin || (req.headers.host ? `https://${req.headers.host}` : null);
      try {
        vendor_notified = await notifyVendor(admin, data.vendor_id, {
          event_type: "po_revised",
          title: `Purchase order ${data.po_number || ""} revised`.trim(),
          body: "Ring of Fire revised this purchase order. Please review the updated quantities, pricing, or dates.",
          link: data.po_number ? `/vendor/pos?q=${encodeURIComponent(data.po_number)}` : null,
          metadata: { po_id: id, po_number: data.po_number || null },
        }, { email: true, origin });
      } catch { /* non-blocking */ }
    }
    return res.status(200).json({ ...data, vendor_notified });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
