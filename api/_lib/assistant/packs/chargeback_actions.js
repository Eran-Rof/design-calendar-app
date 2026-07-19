// P28-4-2 capability pack — Chargeback actions (the first REAL draft action).
//
// ONE action: draft_chargeback_match. For a residual chargeback
// (factor_chargebacks.disposition='open', unmatched) it proposes the single
// unambiguous AR invoice via the SAME pure matcher the #1744 auto-match uses
// (api/_lib/chargebackMatch.js) and, on confirm, writes the link exactly the
// way PATCH /api/internal/chargebacks/:id does — set matched_ar_invoice_id +
// append status_history. No money moves — a chargeback match is a reversible
// link — so no maker-checker; but the confirm handshake is still mandatory.
//
// Action contract (arch section 4):
//   preview(admin, input, ctx)  MODEL-REACHABLE, read-only → { summary,
//                               commit_payload?, warnings[] }
//   commit(admin, payload, ctx) NEVER model-reachable; only the authenticated
//                               confirm endpoint calls it, after the token +
//                               RBAC + replay checks pass.
//
// HOUSE RULE (sacred, mirrored from #1744): when matchChargeback returns null
// (no candidate OR an ambiguous key) we propose NOTHING — a wrong link is worse
// than no link. There is no commit_payload, so there is nothing to confirm.

import { buildInvoiceIndex, matchChargeback, isFactorChurnChargeback } from "../../chargebackMatch.js";
import { validateBulkCoding, BULK_MAX_IDS } from "../../../_handlers/internal/chargebacks/bulk.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === "string" && UUID_RE.test(v.trim());

// A customer with more invoices than one PostgREST page (1000-row cap) cannot
// be scoped in a single read, so we decline rather than index a partial set
// (a partial index could both miss a match AND miss an ambiguity). Realistically
// never hit — one customer's invoice count is in the hundreds.
const PAGE_CAP = 1000;

/** Dollars from integer cents, US format. */
function usd(cents) {
  const n = (Number(cents) || 0) / 100;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Operator-facing reference for a chargeback — never its uuid. */
function chargebackRef(row) {
  const num = (row?.item_num || "").toString().trim();
  if (num) return num;
  const d = (row?.cb_date || "").toString().slice(0, 10);
  return d ? `chargeback ${d}` : "this chargeback";
}

const CB_COLS =
  "id, item_num, amount_cents, customer_id, customer_name, disposition, matched_ar_invoice_id, cb_date, report_month, status_history";

const draftChargebackMatch = {
  name: "draft_chargeback_match",
  label: "Suggest a chargeback match",
  module_key: "finance_misc",
  mode: "write_confirm",
  required_action: "write",
  description:
    "For one open, unmatched chargeback, propose the single unambiguous AR invoice it belongs to " +
    "(exact / numeric-suffix invoice-number match). Confirming writes the link; nothing is proposed " +
    "when no single invoice matches.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      chargeback_id: { type: "string", description: "The residual chargeback to match." },
    },
    required: ["chargeback_id"],
  },

  // MODEL-REACHABLE, read-only.
  async preview(admin, input, _ctx) {
    const chargebackId = (input?.chargeback_id || "").toString().trim();
    if (!isUuid(chargebackId)) {
      return { summary: "That does not look like a chargeback reference.", warnings: ["bad_input"] };
    }

    const { data: cb, error } = await admin
      .from("factor_chargebacks")
      .select(CB_COLS)
      .eq("id", chargebackId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!cb) return { summary: "That chargeback was not found.", warnings: ["not_found"] };

    const ref = chargebackRef(cb);
    if (cb.disposition !== "open") {
      return {
        summary: `Chargeback ${ref} is already dispositioned (${cb.disposition}) — nothing to match.`,
        warnings: ["not_open"],
      };
    }
    if (cb.matched_ar_invoice_id) {
      const { data: inv } = await admin
        .from("ar_invoices").select("invoice_number").eq("id", cb.matched_ar_invoice_id).maybeSingle();
      const invNo = inv?.invoice_number || "an invoice";
      return { summary: `Chargeback ${ref} is already linked to invoice ${invNo}.`, warnings: ["already_matched"] };
    }
    if (!cb.customer_id) {
      return {
        summary: `Chargeback ${ref} (${usd(cb.amount_cents)}) has no linked customer, so a match cannot be scoped safely — open it in the worklist to match manually.`,
        warnings: ["no_customer_scope"],
      };
    }

    // Scope the invoice index to the chargeback's customer — the exact scoping
    // the #1744 dilution code uses — so the read is bounded well under the
    // PostgREST 1000-row cap. Head-count first (never fetch-then-count); a
    // customer larger than one page is declined rather than partially indexed.
    const { count, error: cErr } = await admin
      .from("ar_invoices").select("id", { count: "exact", head: true }).eq("customer_id", cb.customer_id);
    if (cErr) throw new Error(cErr.message);
    if ((count || 0) > PAGE_CAP) {
      return {
        summary: `Chargeback ${ref} (${usd(cb.amount_cents)}) belongs to a customer with too many invoices to scan in one pass — open it in the worklist to match manually.`,
        warnings: ["customer_too_large"],
      };
    }

    const { data: invoices, error: iErr } = await admin
      .from("ar_invoices")
      .select("id, invoice_number, total_amount_cents")
      .eq("customer_id", cb.customer_id)
      .limit(PAGE_CAP);
    if (iErr) throw new Error(iErr.message);

    const index = buildInvoiceIndex(invoices || []);
    const hit = matchChargeback(cb.item_num, index);
    if (!hit) {
      return {
        summary: `No single unambiguous invoice matches chargeback ${ref} (${usd(cb.amount_cents)}) for ${cb.customer_name || "this customer"} — leaving it unmatched (a wrong link is worse than none).`,
        warnings: ["no_unambiguous_match"],
      };
    }

    const invoice = (invoices || []).find((r) => r.id === hit.invoiceId) || null;
    const invNo = invoice?.invoice_number || "the matched invoice";
    const method = hit.method === "invoice_number_exact" ? "exact match" : "numeric-suffix match";
    return {
      summary: `Match chargeback ${ref} (${usd(cb.amount_cents)}) to invoice ${invNo} (${method}).`,
      commit_payload: { chargeback_id: cb.id, matched_ar_invoice_id: hit.invoiceId },
      warnings: [],
    };
  },

  // NEVER model-reachable. Runs only behind the authenticated confirm endpoint.
  async commit(admin, commitPayload, ctx) {
    const chargebackId = (commitPayload?.chargeback_id || "").toString().trim();
    const invoiceId = (commitPayload?.matched_ar_invoice_id || "").toString().trim();
    if (!isUuid(chargebackId) || !isUuid(invoiceId)) {
      return { status: 400, body: { error: "bad_commit_payload" } };
    }

    // Re-verify the chargeback is STILL open + unmatched (guards a race where
    // it was dispositioned or matched between preview and confirm).
    const { data: cb, error } = await admin
      .from("factor_chargebacks")
      .select("id, disposition, matched_ar_invoice_id, customer_id, status_history")
      .eq("id", chargebackId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!cb) return { status: 404, body: { error: "chargeback_not_found" } };
    if (cb.disposition !== "open") return { status: 409, body: { error: "chargeback_no_longer_open" } };
    if (cb.matched_ar_invoice_id) return { status: 409, body: { error: "chargeback_already_matched" } };

    // Defense in depth: the invoice must belong to the chargeback's customer —
    // the link is only ever proposed inside that customer's scope.
    const { data: inv } = await admin
      .from("ar_invoices").select("id, invoice_number, customer_id").eq("id", invoiceId).maybeSingle();
    if (!inv) return { status: 404, body: { error: "invoice_not_found" } };
    if (cb.customer_id && inv.customer_id && inv.customer_id !== cb.customer_id) {
      return { status: 409, body: { error: "invoice_customer_mismatch" } };
    }

    const now = new Date().toISOString();
    const by = ctx?.userId || "assistant-confirm";
    const history = Array.isArray(cb.status_history) ? cb.status_history : [];
    const update = {
      matched_ar_invoice_id: invoiceId,
      match_method: "assistant_suggested", // not 'invoice_number%' / 'manual' → auto-match never clobbers it
      updated_by: by,
      updated_at: now,
      status_history: [
        ...history,
        { at: now, by, field: "matched_ar_invoice_id", from: null, to: invoiceId, note: "assistant-suggested match, operator-confirmed" },
      ],
    };

    const { data: updated, error: updErr } = await admin
      .from("factor_chargebacks")
      .update(update)
      .eq("id", chargebackId)
      .eq("disposition", "open")             // optimistic guard — no-op if it changed under us
      .is("matched_ar_invoice_id", null)
      .select("id, matched_ar_invoice_id, match_method, disposition, updated_by, updated_at")
      .maybeSingle();
    if (updErr) throw new Error(updErr.message);
    if (!updated) return { status: 409, body: { error: "chargeback_no_longer_open" } };

    return {
      status: 200,
      body: { ok: true, invoice_number: inv.invoice_number, chargeback_id: chargebackId, match_method: updated.match_method },
    };
  },
};

// ── Bulk reason-coding ──────────────────────────────────────────────────────
// Classify many un-coded chargebacks with one governed reason code (or un-code
// them). Mirrors PATCH /api/internal/chargebacks/bulk EXACTLY — same validation
// (validateBulkCoding), same churn guard (never code a 610 / "Manual Charge
// Back" row). A reason code is a reversible label, so no maker-checker; the
// confirm handshake is still mandatory (write_confirm).

const bulkCodeChargebacks = {
  name: "bulk_code_chargebacks",
  label: "Bulk-code chargebacks with a reason",
  module_key: "finance_misc",
  mode: "write_confirm",
  required_action: "write",
  description:
    "Set one governed reason code on many chargebacks at once (or clear it to un-code). " +
    "Factor-churn rows are never coded. Confirming writes the coding to every selected row.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
        description: `The chargebacks to code (1..${BULK_MAX_IDS}).`,
      },
      reason_code_id: {
        type: ["string", "null"],
        description: "The governed reason code to apply, or null to un-code.",
      },
    },
    required: ["ids", "reason_code_id"],
  },

  // MODEL-REACHABLE, read-only.
  async preview(admin, input, _ctx) {
    const v = validateBulkCoding(input || {});
    if (v.error) return { summary: v.error, warnings: ["bad_input"] };
    const { ids, reason_code_id } = v.data;

    let label = "un-coded (reason cleared)";
    if (reason_code_id != null) {
      const { data: rc, error } = await admin
        .from("chargeback_reason_codes").select("id, label").eq("id", reason_code_id).maybeSingle();
      if (error) throw new Error(error.message);
      if (!rc) return { summary: "That reason code was not found.", warnings: ["reason_code_not_found"] };
      label = rc.label;
    }

    const { data: rows, error: rErr } = await admin
      .from("factor_chargebacks")
      .select("id, reason, reason_code")
      .in("id", ids)
      .limit(BULK_MAX_IDS);
    if (rErr) throw new Error(rErr.message);
    const found = rows || [];
    // When coding (not un-coding), factor-churn rows are skipped server-side.
    const codeable = reason_code_id == null ? found : found.filter((r) => !isFactorChurnChargeback(r));
    const skipped = found.length - codeable.length;
    if (!codeable.length) {
      return {
        summary: reason_code_id == null
          ? "None of those chargebacks were found."
          : "Every selected chargeback is factor churn (Manual Charge Back) — those are never coded.",
        warnings: ["nothing_to_code"],
      };
    }

    const churnNote = skipped > 0 ? ` (${skipped} factor-churn row${skipped === 1 ? "" : "s"} will be skipped)` : "";
    return {
      summary: `Code ${codeable.length} chargeback${codeable.length === 1 ? "" : "s"} as "${label}"${churnNote}.`,
      commit_payload: { ids, reason_code_id },
      warnings: [],
    };
  },

  // NEVER model-reachable. Runs only behind the authenticated confirm endpoint.
  async commit(admin, commitPayload, ctx) {
    const v = validateBulkCoding(commitPayload || {});
    if (v.error) return { status: 400, body: { error: "bad_commit_payload" } };
    const { ids, reason_code_id } = v.data;

    if (reason_code_id != null) {
      const { data: rc, error } = await admin
        .from("chargeback_reason_codes").select("id").eq("id", reason_code_id).maybeSingle();
      if (error) throw new Error(error.message);
      if (!rc) return { status: 400, body: { error: "reason_code_not_found" } };
    }

    const now = new Date().toISOString();
    const by = ctx?.userId || "assistant-confirm";
    let query = admin
      .from("factor_chargebacks")
      .update({ reason_code_id, updated_by: by, updated_at: now })
      .in("id", ids);
    if (reason_code_id != null) {
      query = query.not("reason_code", "eq", "610").not("reason", "ilike", "%manual charge back%");
    }
    const { data, error } = await query.select("id");
    if (error) throw new Error(error.message);

    return { status: 200, body: { ok: true, updated: (data || []).length } };
  },
};

export default {
  key: "chargeback_actions",
  label: "Chargeback actions",
  module_keys: ["finance_misc"],
  panels: {},
  actions: [draftChargebackMatch, bulkCodeChargebacks],
};
