// h597 — api/internal/procurement/vendor-invoice-drafts/:id
//
// P13-C4 — Vendor-Invoice 3-Way Match vertical, single-draft view + actions.
//
// GET    → draft + a computed match breakdown (PO total, received-and-accepted
//          value, invoice total, variance, tolerance, within-tolerance flag,
//          per-line detail where feasible).
// PATCH  { action:'rematch' }        → recompute the match against the current
//                                       linked POs + their posted receipts.
//        { action:'approve', expense_account_id? }
//                                     → create an AP invoice DRAFT (gl_status
//                                       'draft') in `invoices` + a single line
//                                       in `invoice_line_items`, then point the
//                                       draft at it (ap_invoice_id) and set
//                                       three_way_match_status='posted'. DOES
//                                       NOT post a JE — the AP panel posts.
//        { action:'reject', reason }  → status='rejected' + rejected_reason.
//        { ...field edits }           → edit invoice_date/due_date/total_cents/
//                                       variance_reason (open drafts only).
// DELETE → only when status in pending/variance/exception.
//
// Mirrors api/_handlers/internal/procurement/receipts/[id].js conventions.

import { createClient } from "@supabase/supabase-js";
import { computeMatchForPo, matchTolerance } from "./index.js";
import { postEvent } from "../../../../_lib/accounting/posting/index.js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// decimal-string for cents.
function centsToStr(cents) {
  const n = BigInt(Math.trunc(Number(cents)));
  const neg = n < 0n; const abs = neg ? -n : n;
  return `${neg ? "-" : ""}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, "0")}`;
}
// Resolve a postable GL account by code (2050 GR/IR, 6320 PO Variance, 2010 AP).
async function findPostableAccount(admin, entityId, code) {
  const { data } = await admin.from("gl_accounts")
    .select("id, is_postable, status").eq("entity_id", entityId).eq("code", code).maybeSingle();
  return (data && data.is_postable && data.status === "active") ? data.id : null;
}
const DELETABLE_STATUSES = ["pending", "variance", "exception"];
// A draft can be re-matched / approved / rejected / edited only while it is
// still open (not already turned into an AP invoice or rejected).
const OPEN_STATUSES = ["pending", "matched", "variance", "exception"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
async function resolveDefaultEntityId(admin) {
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data ? data.id : null;
}

const HEADER_COLS =
  "id, entity_id, vendor_id, vendor_invoice_number, invoice_date, due_date, currency, " +
  "total_cents, source_kind, source_pdf_document_id, ocr_confidence_pct, three_way_match_status, " +
  "matched_po_ids, matched_receipt_ids, variance_cents, variance_reason, ap_invoice_id, " +
  "approved_by_user_id, approved_at, rejected_reason, created_at, updated_at";

// Build a display-only match breakdown for the GET payload. Reads the first
// linked PO (the manual path links exactly one) and its posted receipts. The
// stored variance_cents / three_way_match_status remain the source of truth;
// this just gives the UI the supporting numbers + a per-line table.
async function buildBreakdown(admin, entityId, draft) {
  const poIds = Array.isArray(draft.matched_po_ids) ? draft.matched_po_ids : [];
  const total = Number(draft.total_cents) || 0;
  if (poIds.length === 0) {
    return {
      purchase_order_id: null, po_number: null, po_total_cents: null,
      received_value_cents: 0, invoice_total_cents: total,
      variance_cents: Number(draft.variance_cents) || total,
      tolerance_cents: matchTolerance(0), within_tolerance: false,
      lines: [],
    };
  }
  const poId = String(poIds[0]);
  const { data: po } = await admin
    .from("purchase_orders")
    .select("id, po_number, total_cents")
    .eq("id", poId)
    .maybeSingle();

  const { data: poLines } = await admin
    .from("purchase_order_lines")
    .select("id, line_number, description, qty_ordered, unit_cost_cents")
    .eq("purchase_order_id", poId)
    .order("line_number", { ascending: true });
  const poLineById = new Map((poLines || []).map((l) => [String(l.id), l]));

  const receiptIds = Array.isArray(draft.matched_receipt_ids) ? draft.matched_receipt_ids : [];
  let rlines = [];
  if (receiptIds.length > 0) {
    const { data } = await admin
      .from("tanda_po_receipt_lines")
      .select("receipt_id, purchase_order_line_id, qty_accepted, unit_cost_cents")
      .in("receipt_id", receiptIds);
    rlines = data || [];
  }

  // Aggregate accepted qty per PO line.
  const acceptedByLine = new Map();
  for (const rl of rlines) {
    const polId = rl.purchase_order_line_id ? String(rl.purchase_order_line_id) : null;
    if (!polId) continue;
    acceptedByLine.set(polId, (acceptedByLine.get(polId) || 0) + (Number(rl.qty_accepted) || 0));
  }

  let receivedValue = 0;
  const lines = [];
  for (const [polId, accepted] of acceptedByLine.entries()) {
    const pol = poLineById.get(polId);
    const unit = pol ? Number(pol.unit_cost_cents) || 0 : 0;
    const lineValue = accepted * unit;
    receivedValue += lineValue;
    lines.push({
      purchase_order_line_id: polId,
      line_number: pol ? pol.line_number : null,
      description: pol ? pol.description : null,
      qty_ordered: pol ? Number(pol.qty_ordered) || 0 : null,
      qty_accepted: accepted,
      unit_cost_cents: unit,
      line_received_value_cents: lineValue,
    });
  }
  lines.sort((a, b) => (a.line_number || 0) - (b.line_number || 0));

  const variance = total - receivedValue;
  const tolerance = matchTolerance(receivedValue);
  return {
    purchase_order_id: poId,
    po_number: po ? po.po_number : null,
    po_total_cents: po ? Number(po.total_cents) || 0 : null,
    received_value_cents: receivedValue,
    invoice_total_cents: total,
    variance_cents: variance,
    tolerance_cents: tolerance,
    within_tolerance: receiptIds.length > 0 && Math.abs(variance) <= tolerance,
    lines,
  };
}

export default async function handler(req, res, params) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const id = params?.id || req.query?.id;
  if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: "Invalid id" });
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const { data: draft, error: dErr } = await admin
    .from("vendor_invoice_drafts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (dErr) return res.status(500).json({ error: dErr.message });
  if (!draft) return res.status(404).json({ error: "Vendor invoice draft not found" });
  if (draft.entity_id !== entityId) return res.status(404).json({ error: "Vendor invoice draft not found" });

  if (req.method === "GET") {
    const breakdown = await buildBreakdown(admin, entityId, draft);
    return res.status(200).json({ ...draft, match: breakdown });
  }

  if (req.method === "DELETE") {
    if (!DELETABLE_STATUSES.includes(draft.three_way_match_status)) {
      return res.status(409).json({ error: `Only a ${DELETABLE_STATUSES.join("/")} draft can be deleted.` });
    }
    const { error } = await admin.from("vendor_invoice_drafts").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    body = body || {};
    const action = body.action ? String(body.action) : null;

    // ── rematch ───────────────────────────────────────────────────────────
    if (action === "rematch") {
      if (!OPEN_STATUSES.includes(draft.three_way_match_status)) {
        return res.status(409).json({ error: "Only an open draft can be re-matched." });
      }
      const poIds = Array.isArray(draft.matched_po_ids) ? draft.matched_po_ids : [];
      if (poIds.length === 0) {
        return res.status(409).json({ error: "Draft has no linked purchase order to match against." });
      }
      const m = await computeMatchForPo(admin, entityId, Number(draft.total_cents) || 0, String(poIds[0]));
      const patch = {
        matched_receipt_ids: m.receiptIds,
        variance_cents: m.variance,
        three_way_match_status: m.status,
        variance_reason:
          m.status === "exception" ? "No posted receipt found for the linked PO."
          : m.status === "variance" ? `Cost variance ${m.variance} cents exceeds tolerance ${m.tolerance} cents.`
          : null,
      };
      const { data: fresh, error: uErr } = await admin
        .from("vendor_invoice_drafts").update(patch).eq("id", id).select(HEADER_COLS).single();
      if (uErr) return res.status(500).json({ error: uErr.message });
      const breakdown = await buildBreakdown(admin, entityId, fresh);
      return res.status(200).json({ ...fresh, match: breakdown });
    }

    // ── approve → create AP invoice + (if matched) post the GR/IR-clearing JE ─
    //
    // A draft WITHIN the 3-way tolerance (matched) auto-posts: the goods were
    // already booked into inventory by the receipt GRNI JE, so this invoice
    // CLEARS GR/IR (DR 2050 received / DR-CR 6320 variance / CR AP total) and
    // creates NO second inventory layer. A draft OUTSIDE tolerance (variance /
    // exception / pending) keeps the prior behavior: an unposted AP draft with
    // an expense line that a bookkeeper posts via the normal AP flow.
    if (action === "approve") {
      if (!OPEN_STATUSES.includes(draft.three_way_match_status)) {
        return res.status(409).json({ error: "Only an open draft can be approved." });
      }
      if (draft.ap_invoice_id) {
        return res.status(409).json({ error: "Draft already has an AP invoice." });
      }
      const expenseAccountId =
        body.expense_account_id && UUID_RE.test(String(body.expense_account_id)) ? body.expense_account_id : null;

      // Resolve the entity's default AP control account (soft default → 2010).
      const { data: ent } = await admin
        .from("entities").select("default_ap_account_id").eq("id", entityId).maybeSingle();
      const apAccountId = (ent && ent.default_ap_account_id)
        || (await findPostableAccount(admin, entityId, "2010"));

      const dueDate = draft.due_date || draft.invoice_date;
      const totalCents = Number(draft.total_cents) || 0;

      // Recompute the breakdown to decide matched vs not (source of truth = the
      // live receipts, not the stored status).
      const bd = await buildBreakdown(admin, entityId, draft);
      const matched = bd.within_tolerance === true && Number(bd.received_value_cents) > 0;
      const receivedCents = Number(bd.received_value_cents) || 0;

      const grirAcctId = matched ? await findPostableAccount(admin, entityId, "2050") : null;
      const varianceAcctId = matched ? await findPostableAccount(admin, entityId, "6320") : null;
      if (matched && (!grirAcctId || !apAccountId)) {
        return res.status(409).json({ error: "Matched invoice needs postable GR/IR (2050) + AP (2010) accounts to auto-post." });
      }
      if (matched && totalCents !== receivedCents && !varianceAcctId) {
        return res.status(409).json({ error: "Price variance present but no postable PO Variance account (6320)." });
      }

      // 1. AP invoice header. invoices_gl_status_check rejects 'draft' → use
      //    'unposted'; we flip it to 'posted' below for the matched path.
      const { data: inv, error: hErr } = await admin
        .from("invoices")
        .insert({
          entity_id: entityId,
          vendor_id: draft.vendor_id,
          invoice_number: draft.vendor_invoice_number,
          invoice_kind: "vendor_bill",
          gl_status: "unposted",
          posting_date: draft.invoice_date,
          due_date: dueDate,
          expense_account_id: matched ? grirAcctId : expenseAccountId,
          ap_account_id: apAccountId,
          source: "manual",
        })
        .select("id")
        .single();
      if (hErr) {
        if (hErr.code === "23505") {
          return res.status(409).json({ error: "An AP invoice with that number already exists for this vendor." });
        }
        return res.status(500).json({ error: hErr.message });
      }

      // 2. Single line. total_amount_cents is trigger-maintained from
      //    quantity × unit_cost_cents, so set quantity 1 + unit_cost = total.
      //    Matched → the line carries the GR/IR clearing account (cosmetic; the
      //    JE below is what actually posts); else the chosen expense account.
      const { error: lErr } = await admin
        .from("invoice_line_items")
        .insert({
          invoice_id: inv.id,
          entity_id: entityId,
          line_index: 1,
          description: `Vendor invoice ${draft.vendor_invoice_number} (3-way ${matched ? "matched" : "match"})`,
          expense_account_id: matched ? grirAcctId : expenseAccountId,
          inventory_item_id: null,
          quantity: 1,
          unit_cost_cents: totalCents,
          tax_amount_cents: 0,
        });
      if (lErr) {
        await admin.from("invoices").delete().eq("id", inv.id);
        return res.status(500).json({ error: `AP invoice line failed: ${lErr.message}` });
      }

      // 3. Matched → post the GR/IR-clearing JE now + mark the invoice posted.
      let jeId = null;
      if (matched) {
        try {
          const result = await postEvent(admin, {
            kind: "ap_invoice_grir_match",
            entity_id: entityId,
            created_by_user_id: null,
            reason: `GR/IR match ${draft.vendor_invoice_number}`,
            data: {
              invoice_id: inv.id,
              vendor_id: draft.vendor_id,
              invoice_number: draft.vendor_invoice_number,
              invoice_date: draft.invoice_date,
              ap_account_id: apAccountId,
              grir_account_id: grirAcctId,
              variance_account_id: varianceAcctId,
              received_amount: centsToStr(receivedCents),
              total_amount: centsToStr(totalCents),
            },
          });
          jeId = result.accrual_je_id;
        } catch (e) {
          // Roll back the invoice we just created so a failed JE doesn't strand it.
          await admin.from("invoices").delete().eq("id", inv.id);
          return res.status(500).json({ error: `Matched AP invoice JE failed: ${e instanceof Error ? e.message : String(e)}` });
        }
        await admin.from("invoices").update({ gl_status: "posted" }).eq("id", inv.id);
      }

      // 4. Point the draft at the new AP invoice + mark it posted (into AP).
      const { data: fresh, error: uErr } = await admin
        .from("vendor_invoice_drafts")
        .update({
          ap_invoice_id: inv.id,
          three_way_match_status: "posted",
          approved_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select(HEADER_COLS)
        .single();
      if (uErr) {
        return res.status(500).json({ error: `AP invoice ${inv.id} created but linking the draft failed: ${uErr.message}` });
      }
      return res.status(200).json({ ...fresh, ap_invoice_id: inv.id, je_id: jeId, auto_posted: matched });
    }

    // ── reject ──────────────────────────────────────────────────────────────
    if (action === "reject") {
      if (!OPEN_STATUSES.includes(draft.three_way_match_status)) {
        return res.status(409).json({ error: "Only an open draft can be rejected." });
      }
      const reason = body.reason ? String(body.reason).trim() : "";
      if (!reason) return res.status(400).json({ error: "reason required to reject" });
      const { data: fresh, error: uErr } = await admin
        .from("vendor_invoice_drafts")
        .update({ three_way_match_status: "rejected", rejected_reason: reason })
        .eq("id", id)
        .select(HEADER_COLS)
        .single();
      if (uErr) return res.status(500).json({ error: uErr.message });
      return res.status(200).json(fresh);
    }

    // ── field edits (open drafts only) ────────────────────────────────────
    if (action) return res.status(400).json({ error: `Unknown action: ${action}` });
    if (!OPEN_STATUSES.includes(draft.three_way_match_status)) {
      return res.status(409).json({ error: "Only an open draft can be edited." });
    }
    const patch = {};
    if ("invoice_date" in body) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.invoice_date || ""))) {
        return res.status(400).json({ error: "invoice_date must be YYYY-MM-DD" });
      }
      patch.invoice_date = body.invoice_date;
    }
    if ("due_date" in body) {
      if (body.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.due_date))) {
        return res.status(400).json({ error: "due_date must be YYYY-MM-DD" });
      }
      patch.due_date = body.due_date || null;
    }
    if ("total_cents" in body) {
      const t = Math.round(Number(body.total_cents));
      if (!Number.isFinite(t) || t < 0) return res.status(400).json({ error: "total_cents must be a non-negative integer (cents)" });
      patch.total_cents = t;
    }
    if ("variance_reason" in body) patch.variance_reason = body.variance_reason ? String(body.variance_reason).trim() : null;

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "No editable fields supplied." });
    }
    const { data: fresh, error: uErr } = await admin
      .from("vendor_invoice_drafts").update(patch).eq("id", id).select(HEADER_COLS).single();
    if (uErr) return res.status(500).json({ error: uErr.message });
    return res.status(200).json(fresh);
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
