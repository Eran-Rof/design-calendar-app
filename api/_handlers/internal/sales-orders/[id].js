// api/internal/sales-orders/:id
//
// P16 / M10-B.
// GET    → header + lines.
// PATCH  → update mutable header fields, replace lines (when `lines` supplied),
//          and/or change status. Confirming (status → 'confirmed') assigns the
//          immutable so_number (SO-YYYY-NNNNN) if not already set.
// DELETE → only a draft SO (cascades lines).

import { createClient } from "@supabase/supabase-js";
import { resolveInternalRecipients } from "../../../_lib/internal-recipients.js";
import { evaluateSoCreditGate } from "../../../_lib/customers/soShipGate.js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ["draft", "confirmed", "allocated", "fulfilling", "shipped", "invoiced", "closed", "cancelled"];
const FACTOR_STATUSES = ["not_submitted", "pending", "approved", "partial", "declined", "not_required"];
// Non-factor credit gate (house-account overdue-AR + credit-card paid-in-full).
const CREDIT_STATUSES = ["not_required", "pending", "on_hold", "approved", "declined"];

// Item 9 — resolve the revenue account to stamp on each SO line: the customer's
// default_revenue_account_id, else the entity default. Returns a uuid or null.
async function resolveLineRevenueAccount(admin, customerId, entityId) {
  let acct = null;
  if (customerId) {
    const { data: cust } = await admin.from("customers").select("default_revenue_account_id").eq("id", customerId).maybeSingle();
    if (cust?.default_revenue_account_id) acct = cust.default_revenue_account_id;
  }
  if (!acct && entityId) {
    const { data: ent } = await admin.from("entities").select("default_revenue_account_id").eq("id", entityId).maybeSingle();
    if (ent?.default_revenue_account_id) acct = ent.default_revenue_account_id;
  }
  return acct || null;
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

async function nextSoNumber(admin, entityId, year) {
  const prefix = `SO-${year}-`;
  const { count } = await admin.from("sales_orders")
    .select("id", { count: "exact", head: true })
    .eq("entity_id", entityId)
    .ilike("so_number", `${prefix}%`);
  return `${prefix}${String((count || 0) + 1).padStart(5, "0")}`;
}

export default async function handler(req, res, params) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const id = params?.id || req.query?.id;
  if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: "Invalid id" });
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: so, error: soErr } = await admin.from("sales_orders").select("*").eq("id", id).maybeSingle();
  if (soErr) return res.status(500).json({ error: soErr.message });
  if (!so) return res.status(404).json({ error: "Sales order not found" });

  if (req.method === "GET") {
    const { data: lines, error: lErr } = await admin.from("sales_order_lines")
      .select("*").eq("sales_order_id", id).order("line_number", { ascending: true });
    if (lErr) return res.status(500).json({ error: lErr.message });
    // Decorate each line with its SKU decomposition (style_code / color / size /
    // sku_code) so the SO modal can rebuild the size-matrix body when editing.
    const ids = [...new Set((lines || []).map((l) => l.inventory_item_id).filter(Boolean))];
    let skuById = new Map();
    if (ids.length) {
      const { data: skus } = await admin.from("ip_item_master").select("id, style_code, color, size, inseam, sku_code").in("id", ids);
      skuById = new Map((skus || []).map((s) => [s.id, s]));
    }
    const decorated = (lines || []).map((l) => {
      const s = l.inventory_item_id ? skuById.get(l.inventory_item_id) : null;
      return { ...l, style_code: s?.style_code ?? null, color: s?.color ?? null, size: s?.size ?? null, inseam: s?.inseam ?? null, sku_code: s?.sku_code ?? null };
    });
    // Resolve the buyer's name (no raw UUID in the UI).
    let buyer_name = null;
    if (so.buyer_id) {
      const { data: buyer } = await admin.from("customer_buyers").select("name").eq("id", so.buyer_id).maybeSingle();
      buyer_name = buyer?.name ?? null;
    }
    return res.status(200).json({ ...so, buyer_name, lines: decorated });
  }

  if (req.method === "DELETE") {
    if (so.status !== "draft") return res.status(409).json({ error: "Only a draft sales order can be deleted (cancel a confirmed one instead)." });
    const { error } = await admin.from("sales_orders").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    body = body || {};

    const patch = {};
    const nz = (k) => (body[k] && UUID_RE.test(String(body[k])) ? body[k] : null);
    for (const k of ["ship_to_location_id", "brand_id", "channel_id", "payment_terms_id", "ar_account_id", "revenue_account_id"]) {
      if (k in body) patch[k] = nz(k);
    }
    if ("customer_id" in body) {
      if (!UUID_RE.test(String(body.customer_id))) return res.status(400).json({ error: "customer_id must be a uuid" });
      patch.customer_id = body.customer_id;
    }
    // Optional buyer — null clears it; otherwise must be a buyer on the SO's
    // (possibly being-patched) customer.
    if ("buyer_id" in body) {
      if (body.buyer_id == null || body.buyer_id === "") {
        patch.buyer_id = null;
      } else if (!UUID_RE.test(String(body.buyer_id))) {
        return res.status(400).json({ error: "buyer_id must be a uuid" });
      } else {
        const custForBuyer = ("customer_id" in patch ? patch.customer_id : so.customer_id);
        const { data: b } = await admin.from("customer_buyers").select("id, customer_id").eq("id", body.buyer_id).maybeSingle();
        if (!b) return res.status(400).json({ error: "buyer_id not found" });
        if (b.customer_id !== custForBuyer) return res.status(400).json({ error: "buyer_id must belong to the order's customer" });
        patch.buyer_id = body.buyer_id;
      }
    }
    for (const k of ["order_date", "requested_ship_date", "cancel_date"]) {
      if (k in body) patch[k] = /^\d{4}-\d{2}-\d{2}$/.test(body[k] || "") ? body[k] : null;
    }
    if ("notes" in body) patch.notes = body.notes ? String(body.notes).trim() : null;
    if ("customer_po" in body) patch.customer_po = body.customer_po ? String(body.customer_po).trim() : null;
    if ("sale_store" in body) patch.sale_store = body.sale_store && String(body.sale_store).trim() ? String(body.sale_store).trim() : null;
    if ("is_bulk_order" in body) patch.is_bulk_order = body.is_bulk_order === true;
    // Scenario 2 — placeholder flag. Explicit value wins; otherwise replacing the
    // customer PO on a placeholder SO clears the flag (it's now a real buyer PO).
    if ("customer_po_is_placeholder" in body) patch.customer_po_is_placeholder = body.customer_po_is_placeholder === true;
    else if ("customer_po" in body && so.customer_po_is_placeholder) patch.customer_po_is_placeholder = false;
    if ("fulfillment_source" in body) patch.fulfillment_source = ["production", "ats"].includes(body.fulfillment_source) ? body.fulfillment_source : null;
    if ("is_closeout" in body) patch.is_closeout = body.is_closeout === true || body.is_closeout === "true";

    // Item 3 — factor / credit-insurance approval (manual).
    if ("factor_approval_status" in body) {
      const fs = body.factor_approval_status;
      if (fs == null || fs === "") {
        patch.factor_approval_status = "not_submitted";
      } else if (!FACTOR_STATUSES.includes(fs)) {
        return res.status(400).json({ error: `factor_approval_status must be one of ${FACTOR_STATUSES.join(", ")}` });
      } else {
        patch.factor_approval_status = fs;
      }
    }
    if ("factor_reference" in body) patch.factor_reference = body.factor_reference ? String(body.factor_reference).trim() : null;
    if ("factor_approved_cents" in body) {
      if (body.factor_approved_cents == null || body.factor_approved_cents === "") {
        patch.factor_approved_cents = null;
      } else {
        const n = typeof body.factor_approved_cents === "number" ? body.factor_approved_cents : parseInt(body.factor_approved_cents, 10);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return res.status(400).json({ error: "factor_approved_cents must be a non-negative integer" });
        patch.factor_approved_cents = n;
      }
    }

    // Non-factor credit gate — manual operator override/release. Accepting
    // credit_approval_status on PATCH lets an operator approve (release a hold),
    // decline, or reset the gate. When approving, we stamp the source as
    // 'manual' and record who did it; an explicit credit_approval_source in the
    // body wins (e.g. the record-payment endpoint sets 'payment'). This is the
    // sole UI-writable path for the gate — the confirm/ship logic below sets it
    // automatically otherwise.
    if ("credit_approval_status" in body) {
      const cs = body.credit_approval_status;
      if (cs == null || cs === "") {
        patch.credit_approval_status = "not_required";
      } else if (!CREDIT_STATUSES.includes(cs)) {
        return res.status(400).json({ error: `credit_approval_status must be one of ${CREDIT_STATUSES.join(", ")}` });
      } else {
        patch.credit_approval_status = cs;
        if (cs === "approved") {
          patch.credit_approval_source = body.credit_approval_source && ["manual", "auto", "payment"].includes(body.credit_approval_source)
            ? body.credit_approval_source : "manual";
          patch.credit_approved_by_user_id =
            (body.credit_approved_by_user_id && UUID_RE.test(String(body.credit_approved_by_user_id)))
              ? body.credit_approved_by_user_id : null;
          patch.credit_hold_reason = null; // releasing the hold clears the reason
        }
      }
      patch.credit_checked_at = new Date().toISOString();
    }

    if ("status" in body) {
      if (!STATUSES.includes(body.status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}` });

      // Chunk K (operator item 17) — factored-customer ship-gate.
      // A factored customer's SO cannot move into the pick/pack ('fulfilling')
      // or ship ('shipped') stages until factor approval is 'approved'.
      // 'shipped' is the hard gate; we block at 'fulfilling' too to be safe.
      // The effective factor status is the PATCH value when supplied, else
      // the current row value.
      if (body.status === "fulfilling" || body.status === "shipped") {
        const custId = ("customer_id" in patch ? patch.customer_id : so.customer_id);
        if (custId) {
          const { data: cust } = await admin
            .from("customers")
            .select("is_factored")
            .eq("id", custId)
            .maybeSingle();
          if (cust?.is_factored === true) {
            const effFactor = ("factor_approval_status" in patch)
              ? patch.factor_approval_status
              : so.factor_approval_status;
            if (effFactor !== "approved") {
              return res.status(409).json({
                error: "Factored customer — factor approval required before shipping. Set Factor/Ins Approval = approved on the sales order first.",
              });
            }
          } else {
            // NON-factored: enforce the credit ship-gate (house-account overdue
            // AR / credit-card paid-in-full). An operator override sets
            // credit_approval_status='approved' which always releases the gate.
            // The effective status is the PATCH value when supplied, else the
            // current row value.
            const effCredit = ("credit_approval_status" in patch)
              ? patch.credit_approval_status
              : so.credit_approval_status;
            if (effCredit !== "approved") {
              try {
                const decision = await evaluateSoCreditGate(admin, {
                  customer_id: custId,
                  entity_id: so.entity_id,
                  payment_terms_id: ("payment_terms_id" in patch ? patch.payment_terms_id : so.payment_terms_id),
                  total_cents: so.total_cents,
                  amount_paid_cents: so.amount_paid_cents,
                });
                if (decision.blocked) {
                  return res.status(409).json({ error: decision.reason, credit_gate: decision.gate });
                }
              } catch (e) {
                // High-stakes: if the overdue-AR lookup fails we DO NOT silently
                // allow the ship — surface the error so the operator/ops notices.
                return res.status(500).json({ error: `Credit gate check failed: ${e instanceof Error ? e.message : String(e)}` });
              }
            }
          }
        }
      }

      patch.status = body.status;
      // Assign the immutable SO number when first confirmed.
      if (body.status === "confirmed" && !so.so_number) {
        const year = (so.order_date || new Date().toISOString().slice(0, 10)).slice(0, 4);
        patch.so_number = await nextSoNumber(admin, so.entity_id, year);
      }

      // On confirm — capture-but-hold: evaluate the non-factor credit gate and
      // stamp credit_approval_status (on_hold for house-account overdue AR,
      // pending for an unpaid credit-card order). The SO still saves either way.
      // An operator override already in this PATCH ('approved'/'declined') is
      // respected — we never downgrade an explicit operator decision. Factored
      // customers are skipped (the factor gate owns them).
      if (body.status === "confirmed" && !("credit_approval_status" in patch)) {
        const effCredit = so.credit_approval_status;
        if (effCredit !== "approved" && effCredit !== "declined") {
          try {
            const decision = await evaluateSoCreditGate(admin, {
              customer_id: ("customer_id" in patch ? patch.customer_id : so.customer_id),
              entity_id: so.entity_id,
              payment_terms_id: ("payment_terms_id" in patch ? patch.payment_terms_id : so.payment_terms_id),
              // Use the post-line-replace total when this PATCH also rewrites lines.
              total_cents: ("total_cents" in patch ? patch.total_cents : so.total_cents),
              amount_paid_cents: so.amount_paid_cents,
            });
            patch.credit_approval_status = decision.target_status;
            patch.credit_hold_reason = decision.reason;
            patch.credit_checked_at = new Date().toISOString();
          } catch {
            // Non-blocking at confirm — the hard block lives at the ship/
            // fulfilling transition (which re-evaluates and surfaces errors).
          }
        }
      }
    }

    // Replace lines if supplied. Allowed while DRAFT or CONFIRMED (the "Add
    // styles" flow re-opens a confirmed order to append styles) — but not once
    // stock is committed: allocated / fulfilling / shipped / invoiced / closed
    // are line-locked. (A status change in the same PATCH — e.g. the initial
    // draft→confirm that ships lines together — is always allowed.)
    if (Array.isArray(body.lines)) {
      const LINE_EDITABLE = ["draft", "confirmed"];
      if (!LINE_EDITABLE.includes(so.status) && !("status" in body)) {
        return res.status(409).json({ error: "Lines can only be edited while the order is draft or confirmed (before allocation / shipping)." });
      }
      // Item 9 — revenue is auto-routed from the customer master (entity fallback),
      // not taken from the per-line payload.
      const custForRouting = ("customer_id" in patch ? patch.customer_id : so.customer_id);
      const lineRevenueAccountId = await resolveLineRevenueAccount(admin, custForRouting, so.entity_id);
      const norm = [];
      let ln = 1;
      for (const l of body.lines) {
        const qty = Number(l.qty_ordered);
        if (!Number.isFinite(qty) || qty <= 0) continue;
        const unit = l.unit_price_cents == null || l.unit_price_cents === "" ? 0 : Math.round(Number(l.unit_price_cents));
        norm.push({
          sales_order_id: id, line_number: ln++,
          inventory_item_id: l.inventory_item_id && UUID_RE.test(String(l.inventory_item_id)) ? l.inventory_item_id : null,
          description: l.description ? String(l.description).trim() : null,
          qty_ordered: qty, unit_price_cents: unit, line_total_cents: Math.round(qty * unit),
          revenue_account_id: lineRevenueAccountId,
          lot_number: l.lot_number != null && String(l.lot_number).trim() !== "" ? String(l.lot_number).trim() : null,
        });
      }
      await admin.from("sales_order_lines").delete().eq("sales_order_id", id);
      if (norm.length) {
        const { error: lErr } = await admin.from("sales_order_lines").insert(norm);
        if (lErr) return res.status(500).json({ error: `Line update failed: ${lErr.message}` });
      }
      const subtotal = norm.reduce((s, l) => s + l.line_total_cents, 0);
      patch.subtotal_cents = subtotal;
      patch.total_cents = subtotal;
    }

    if (Object.keys(patch).length === 0) return res.status(200).json(so);
    const { data, error } = await admin.from("sales_orders").update(patch).eq("id", id).select("*").single();
    if (error) return res.status(500).json({ error: error.message });

    // Scenario 2 — replacing the SO's customer PO (e.g. a placeholder → the real
    // buyer PO) re-lots every NOT-YET-RECEIVED PO linked to this SO: lines that
    // carried the OLD customer PO as their lot switch to the new one. Received /
    // cancelled POs are left as-is (their stock is already lot-stamped on layers).
    let relotted = null;
    const oldPo = (so.customer_po || "").trim();
    const newPo = ("customer_po" in patch) ? (patch.customer_po || "").trim() : oldPo;
    if ("customer_po" in body && oldPo && newPo && newPo !== oldPo) {
      const { data: pos } = await admin.from("purchase_orders")
        .select("id").eq("sales_order_id", id).not("status", "in", "(received,cancelled)");
      const poIds = (pos || []).map((p) => p.id);
      let lines = 0;
      if (poIds.length) {
        const { data: upd } = await admin.from("purchase_order_lines")
          .update({ lot_number: newPo }).in("purchase_order_id", poIds).eq("lot_number", oldPo).select("id");
        lines = (upd || []).length;
      }
      relotted = { pos: poIds.length, lines, from: oldPo, to: newPo };
    }

    // Production fulfillment alert — when this PATCH confirms the order and the
    // effective fulfillment source is Production, notify the Production team
    // (email + in-app) via the "production" notification category. Best-effort:
    // never block or fail the SO save on a notification hiccup.
    let productionNotice = null;
    if (patch.status === "confirmed" && data.fulfillment_source === "production") {
      try {
        const { emails, empty } = await resolveInternalRecipients(admin, "production", { event: "production_order_requested" });
        if (empty) {
          productionNotice = { sent: 0, skipped: true, reason: "No Production recipient configured — tick the Production category on an employee record (or set INTERNAL_PRODUCTION_EMAILS) so the Production Manager is alerted." };
        } else {
          const origin = `https://${req.headers.host}`;
          const soNo = data.so_number || String(id).slice(0, 8);
          await Promise.all(emails.map((email) =>
            fetch(`${origin}/api/send-notification`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                event_type: "production_order_requested",
                title: `Production order: ${soNo}`,
                body: `Sales order ${soNo} was confirmed for PRODUCTION fulfillment. Review it in Tangerine → Sales Orders.`,
                // Deep-link straight to this SO: q= filters the Sales Orders
                // list to the so_number (falls back to the bare list if the
                // number isn't assigned yet). The shared notificationLink
                // resolver also derives this from metadata as a backstop.
                link: data.so_number
                  ? `/tangerine?m=sales_orders&q=${encodeURIComponent(data.so_number)}`
                  : "/tangerine?m=sales_orders",
                metadata: { sales_order_id: id, so_number: data.so_number || null, fulfillment_source: "production" },
                recipient: { internal_id: "production", email },
                dedupe_key: `production_order_${id}`,
                email: true,
              }),
            }).catch(() => {})
          ));
          productionNotice = { sent: emails.length };
        }
      } catch { /* non-blocking */ }
    }
    return res.status(200).json({ ...data, ...(productionNotice ? { production_notice: productionNotice } : {}), ...(relotted ? { relotted } : {}) });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
