// P28-4-4 capability pack — Customer-service case (a low-risk, no-money draft).
//
// ONE action: draft_case. The assistant proposes creating a customer-service
// case (subject, optional body, optional customer / invoice / order / RMA
// links). On operator Confirm it inserts the case exactly the way the human
// cases POST does (api/_handlers/internal/cases/index.js) — REUSING that
// handler's exported validateInsert + nextCaseNumber, and replicating its ~15-
// line insert (the insert itself is not exported as a service fn). No money
// moves, so no maker-checker; but the confirm handshake is still mandatory
// (mode:"write_confirm") so it rides the same Confirm card as every other write.
//
// HOUSE RULE: a case needs a real, non-empty subject. An empty subject ⇒ no
// commit_payload, so there is nothing to confirm.

import { resolveEntityId } from "../context.js";
import { validateInsert, nextCaseNumber } from "../../../_handlers/internal/cases/index.js";

const SEVERITY_VALUES = ["low", "normal", "high", "urgent"];
const STATUS_VALUES = ["open", "in_progress", "resolved", "closed"];

/** Collapse a free-text value to a safe single trimmed line. */
function cleanLine(s, max = 200) {
  return (s == null ? "" : String(s)).replace(/\s+/g, " ").trim().slice(0, max);
}

/** Year bucket for the case number — from the operator's today, else UTC now. */
function caseYear(todayISO) {
  const m = /^(\d{4})-/.exec(String(todayISO || ""));
  return m ? parseInt(m[1], 10) : new Date().getUTCFullYear();
}

const INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    subject: { type: "string", description: "Short, required subject line for the case." },
    body: { type: "string", description: "Optional longer description of the issue." },
    severity: { type: "string", enum: SEVERITY_VALUES, description: "Case severity (defaults to normal)." },
    status: { type: "string", enum: STATUS_VALUES, description: "Initial status (defaults to open)." },
    customer_id: { type: "string", description: "Optional linked customer id (uuid)." },
    ar_invoice_id: { type: "string", description: "Optional linked AR invoice id (uuid)." },
    rma_id: { type: "string", description: "Optional linked RMA id (uuid)." },
    sales_order_id: { type: "string", description: "Optional linked sales order id (uuid)." },
  },
  required: ["subject"],
};

// The subset of validated fields that make up the case body (everything the
// canonical commit_payload carries — auto case_number + created_by are set at
// commit, not previewed).
function caseFields(data) {
  return {
    subject: data.subject,
    body: data.body,
    status: data.status,
    severity: data.severity,
    customer_id: data.customer_id,
    ar_invoice_id: data.ar_invoice_id,
    rma_id: data.rma_id,
    sales_order_id: data.sales_order_id,
    external_email: data.external_email,
  };
}

const draftCase = {
  name: "draft_case",
  label: "Open a case",
  // The cases surface gates on the "cases" module_key (same key the cases_inbox
  // pack's todos declare). Creating a case is a write. Re-checked at confirm.
  module_key: "cases",
  required_action: "write",
  mode: "write_confirm",
  description:
    "Propose creating a customer-service case (a subject, an optional body, and optional customer / invoice / " +
    "order / RMA links). Confirming inserts the case in the cases queue. A case needs a non-empty subject.",
  input_schema: INPUT_SCHEMA,

  // MODEL-REACHABLE, read-only. Validates via the REAL handler validator;
  // returns a commit_payload ONLY when the case is well-formed (non-empty
  // subject, valid enums + link ids).
  async preview(admin, input, _ctx) {
    const v = validateInsert(input || {});
    if (v.error) {
      const code = /subject/i.test(v.error) ? "missing_subject" : "invalid_case";
      return { summary: `A case can't be drafted: ${v.error}. Nothing was created.`, warnings: [code] };
    }

    // Optional: name the linked customer (never show its id).
    let customerClause = "";
    if (v.data.customer_id && admin) {
      try {
        const { data: cust } = await admin
          .from("customers").select("name, code").eq("id", v.data.customer_id).maybeSingle();
        const name = cleanLine(cust?.name || cust?.code || "");
        if (name) customerClause = ` for ${name}`;
      } catch { customerClause = ""; }
    }

    return {
      summary: `Open a ${v.data.severity} case${customerClause}: "${cleanLine(v.data.subject)}" (status ${v.data.status}). Confirming creates it in the cases queue.`,
      commit_payload: caseFields(v.data),
      warnings: [],
    };
  },

  // NEVER model-reachable. Runs only behind the authenticated confirm endpoint.
  // Inserts the case exactly as the human cases POST does.
  async commit(admin, commitPayload, ctx) {
    const v = validateInsert(commitPayload || {});
    if (v.error) return { status: 400, body: { error: v.error } };

    const entityId = await resolveEntityId(admin, ctx?.entityId || null);
    if (!entityId) return { status: 400, body: { error: "missing_entity" } };

    const caseNumber = v.data.case_number || (await nextCaseNumber(admin, entityId, caseYear(ctx?.todayISO)));

    const row = {
      entity_id: entityId,
      case_number: caseNumber,
      subject: v.data.subject,
      body: v.data.body,
      status: v.data.status,
      severity: v.data.severity,
      customer_id: v.data.customer_id,
      ar_invoice_id: v.data.ar_invoice_id,
      rma_id: v.data.rma_id,
      sales_order_id: v.data.sales_order_id,
      external_email: v.data.external_email,
      // The confirming operator authors the case.
      created_by_user_id: ctx?.userId || v.data.created_by_user_id || null,
    };

    const { data: inserted, error: insErr } = await admin
      .from("cases").insert(row).select().single();
    if (insErr) {
      if (insErr.code === "23505") {
        return { status: 409, body: { error: `case_number ${caseNumber} already exists for this entity` } };
      }
      return { status: 500, body: { error: insErr.message } };
    }

    return {
      status: 201,
      body: {
        ok: true,
        case_number: inserted.case_number,
        subject: inserted.subject,
        status: inserted.status,
        severity: inserted.severity,
      },
    };
  },
};

export default {
  key: "case_actions",
  label: "Case actions",
  module_keys: ["cases"],
  panels: {},
  actions: [draftCase],
};
