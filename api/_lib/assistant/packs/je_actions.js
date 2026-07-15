// P28-4-3 capability pack — Manual Journal Entry (the first MONEY draft action).
//
// ONE action: draft_manual_je. The assistant proposes a balanced manual journal
// entry (CEO decision D2 — propose lines broadly for any JE the operator
// describes, NEVER inventing an account code). On operator Confirm the action
// posts through the EXACT existing human path
// (api/_handlers/internal/journal-entries/index.js POST): it runs the T11
// reason gate, then requestIfRequired({kind:"je_manual_post"}); anything at or
// above the approval threshold is HELD as a pending approval for a DIFFERENT
// authorized user to approve (maker-checker), and only below-threshold entries
// post immediately via the shared postManualJournalEntry service. No new
// posting engine, no new approvals path — arch doc §7 action (b) / §5.3.
//
// Two house rules are structural here:
//   1. Never invent a GL account — every proposed line's account_code is
//      resolved against gl_accounts; any unresolved (or non-postable/inactive)
//      account ⇒ NO commit_payload, so there is nothing to confirm.
//   2. The JE must balance (Σdebits == Σcredits, > 0) before it can be
//      confirmed — enforced by REUSING the real handler validator
//      (validateManualPost), not a re-implementation.
// created_by = the confirming operator (ctx.userId), so self-approval is
// structurally impossible (decide() refuses approve when created_by == approver).

import { randomUUID } from "node:crypto";
import { requestIfRequired, resolveSteps } from "../../approvals/index.js";
import { requireReason } from "../../audit/withAuditContext.js";
import { resolveEntityId } from "../context.js";
import {
  validateManualPost,
  postManualJournalEntry,
  sumDebitCents,
} from "../../../_handlers/internal/journal-entries/index.js";

// Account resolution is scoped to the specific codes proposed, so the read is
// always a handful of rows — far under the PostgREST 1000-row cap. The limit is
// a belt-and-braces guard, never actually reached.
const PAGE_CAP = 1000;

/** Dollars from integer cents, US format. */
function usd(cents) {
  const n = (Number(cents) || 0) / 100;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Collapse a free-text value to a safe single trimmed line. */
function cleanLine(s, max = 240) {
  return (s == null ? "" : String(s)).replace(/\s+/g, " ").trim().slice(0, max);
}

/** Canonical account code as it appears in the chart (uppercased, trimmed). */
function cleanCode(s) {
  return (s == null ? "" : String(s)).trim().toUpperCase();
}

// Non-negative integer cents from the model's input (number or numeric string).
// Omitted/empty ⇒ 0. Anything else (float, negative, non-numeric) ⇒ null (invalid).
function centsInput(v) {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

// Integer cents → the decimal dollar STRING the JE body/validator expects
// (money is dollars there, e.g. 41200 → "412.00"). Exact for integer cents.
function centsToMoney(cents) {
  const whole = Math.floor(cents / 100);
  const frac = String(cents % 100).padStart(2, "0");
  return `${whole}.${frac}`;
}

const INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    lines: {
      type: "array",
      minItems: 2,
      description: "The journal lines. Each line debits OR credits one account; the entry must balance.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          account_code: { type: "string", description: "GL account code exactly as it appears in the chart of accounts (e.g. '4011')." },
          debit_cents: { type: "integer", minimum: 0, description: "Debit amount in integer cents (omit or 0 on a credit line)." },
          credit_cents: { type: "integer", minimum: 0, description: "Credit amount in integer cents (omit or 0 on a debit line)." },
          memo: { type: "string", description: "Optional per-line memo." },
        },
        required: ["account_code"],
      },
    },
    description: { type: "string", description: "What this journal entry records." },
    reason: { type: "string", description: "Audit reason (T11) — why this entry is being posted." },
    posting_date: { type: "string", description: "Posting date, YYYY-MM-DD (defaults to today)." },
    basis: { type: "string", enum: ["ACCRUAL", "CASH", "BOTH"], description: "Accounting basis (defaults to ACCRUAL)." },
  },
  required: ["lines", "description", "reason"],
};

const draftManualJe = {
  name: "draft_manual_je",
  label: "Draft a journal entry",
  // journal-entries → je_entry in routePermissions.js, but je_entry only exposes
  // read/write/export; the POSTABLE JE module is je_post. Posting to the GL is a
  // post-grade action, so this action gates on je_post:post (which admin +
  // accountant hold). required_action:"post" is re-checked authoritatively at the
  // confirm endpoint.
  module_key: "je_post",
  required_action: "post",
  mode: "write_confirm",
  description:
    "Propose a balanced manual journal entry (debit/credit lines against real chart-of-accounts codes, a description and an audit reason). " +
    "Confirming posts it through the normal approval path — anything at or above the approval threshold is held for a different authorized user to approve. " +
    "Never invents an account; only balanced entries can be confirmed.",
  input_schema: INPUT_SCHEMA,

  // MODEL-REACHABLE, read-only. Resolves accounts + validates balance; returns a
  // commit_payload ONLY when the proposed JE is real and balanced.
  async preview(admin, input, ctx) {
    const entityId = await resolveEntityId(admin, ctx?.entityId || null);
    if (!entityId) {
      return { summary: "No active accounting entity is configured, so a journal entry cannot be drafted.", warnings: ["no_entity"] };
    }

    const description = cleanLine(input?.description);
    if (!description) {
      return { summary: "A journal entry needs a short description of what it records.", warnings: ["missing_description"] };
    }

    // T11 — a reason is required for any post. Refuse to draft without one.
    const reason = cleanLine(input?.reason);
    if (!reason) {
      return { summary: `Journal entry "${description}" needs a reason for the audit trail before it can be posted.`, warnings: ["missing_reason"] };
    }

    const basis = cleanCode(input?.basis) || "ACCRUAL";
    if (!["ACCRUAL", "CASH", "BOTH"].includes(basis)) {
      return { summary: `Basis must be ACCRUAL, CASH or BOTH (got "${input?.basis}").`, warnings: ["bad_basis"] };
    }

    const postingDate = cleanLine(input?.posting_date) || cleanLine(ctx?.todayISO) || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(postingDate)) {
      return { summary: "Posting date must be a real date (YYYY-MM-DD).", warnings: ["bad_posting_date"] };
    }

    const rawLines = Array.isArray(input?.lines) ? input.lines : [];
    if (rawLines.length < 2) {
      return { summary: "A journal entry needs at least two lines (a debit and a credit).", warnings: ["too_few_lines"] };
    }

    // Every line must name an account code; resolve the DISTINCT codes in one
    // scoped read (well under the row cap).
    const codes = [];
    for (const raw of rawLines) {
      const code = cleanCode(raw?.account_code);
      if (!code) {
        return { summary: "Every line must name a GL account code — I won't guess one.", warnings: ["missing_account_code"] };
      }
      if (!codes.includes(code)) codes.push(code);
    }

    const { data: accts, error } = await admin
      .from("gl_accounts")
      .select("id, code, name, is_postable, status")
      .eq("entity_id", entityId)
      .in("code", codes)
      .limit(PAGE_CAP);
    if (error) throw new Error(error.message);
    const byCode = new Map((accts || []).map((a) => [cleanCode(a.code), a]));

    // Build the JE body lines, converting integer-cent input into the decimal
    // dollar strings the JE validator/poster expect.
    const unknown = [];
    const notPostable = [];
    const bodyLines = [];
    let ln = 0;
    for (const raw of rawLines) {
      ln += 1;
      const code = cleanCode(raw?.account_code);
      const acct = byCode.get(code);
      if (!acct) { unknown.push(code); continue; }
      if (acct.status && acct.status !== "active") { notPostable.push(code); continue; }
      if (acct.is_postable === false) { notPostable.push(code); continue; }

      const dCents = centsInput(raw?.debit_cents);
      const cCents = centsInput(raw?.credit_cents);
      if (dCents == null || cCents == null) {
        return { summary: `Line ${ln} (${code}) has an invalid amount — debit/credit must be whole non-negative cents.`, warnings: ["invalid_amount"] };
      }
      bodyLines.push({
        line_number: ln,
        account_id: acct.id,
        debit: centsToMoney(dCents),
        credit: centsToMoney(cCents),
        memo: cleanLine(raw?.memo, 240) || null,
      });
    }

    // NEVER invent an account: any unresolved code blocks the whole draft.
    if (unknown.length) {
      const list = [...new Set(unknown)].join(", ");
      return { summary: `These codes are not in the chart of accounts: ${list}. Nothing was drafted — I won't invent an account.`, warnings: ["unknown_account"] };
    }
    if (notPostable.length) {
      const list = [...new Set(notPostable)].join(", ");
      return { summary: `These accounts can't be posted to directly (inactive or roll-up): ${list}. Pick a postable account.`, warnings: ["account_not_postable"] };
    }

    // Reuse the REAL handler validator: balance, both-sides, per-line rules.
    // A malformed proposal is caught HERE (preview), never at commit.
    const v = validateManualPost({
      basis,
      posting_date: postingDate,
      description,
      journal_type: "manual",
      lines: bodyLines,
    });
    if (v.error) {
      const code = /unbalanced/i.test(v.error) ? "unbalanced" : "invalid_je";
      return { summary: `That journal entry can't be posted: ${v.error}. Nothing was drafted.`, warnings: [code] };
    }

    // Approval amount == the human path's amount (same sumDebitCents).
    const totalDebitCents = Number(sumDebitCents(v.data.lines));

    // Predict whether the approval threshold will hold this — using the SAME
    // matcher the commit routes through (source_kind:"manual"). Advisory only;
    // commit does the authoritative routing.
    let willHold = null;
    let thresholdCents = null;
    try {
      const { data: rules } = await admin
        .from("approval_rules")
        .select("id, match, steps")
        .eq("entity_id", entityId)
        .eq("kind", "je_manual_post")
        .eq("is_active", true);
      const { matched } = resolveSteps(rules || [], { amount_cents: totalDebitCents, source_kind: "manual" });
      willHold = matched.length > 0;
      const mins = (rules || [])
        .map((r) => Number(r?.match?.min_amount_cents))
        .filter((x) => Number.isFinite(x));
      if (mins.length) thresholdCents = Math.min(...mins);
    } catch { willHold = null; }

    const thr = thresholdCents != null ? usd(thresholdCents) : "$5,000";
    let approvalClause;
    if (willHold === true) {
      approvalClause = `This is at or above the ${thr} approval threshold, so confirming submits it for approval — a different authorized user must approve it before it posts.`;
    } else if (willHold === false) {
      approvalClause = `This is below the ${thr} approval threshold, so confirming posts it immediately.`;
    } else {
      approvalClause = `Anything at or above the ${thr} approval threshold is held for a different authorized user to approve.`;
    }

    return {
      summary: `Post JE: ${v.data.lines.length} lines, ${usd(totalDebitCents)} — ${description}. ${approvalClause}`,
      commit_payload: {
        basis: v.data.basis,
        posting_date: v.data.posting_date,
        description: v.data.description,
        journal_type: v.data.journal_type || "manual",
        reason,
        lines: v.data.lines,
      },
      warnings: willHold === true ? ["requires_approval"] : [],
    };
  },

  // NEVER model-reachable. Runs only behind the authenticated confirm endpoint,
  // after token verify + authoritative RBAC + single-use jti reserve. Routes the
  // post through the EXACT human JE path.
  async commit(admin, commitPayload, ctx) {
    const entityId = ctx?.entityId;
    if (!entityId) return { status: 400, body: { error: "missing_entity" } };

    // Defense in depth: re-validate the body. preview==commit is already enforced
    // by the token hash, but we never hand an unvalidated body to the poster.
    const v = validateManualPost({
      basis: commitPayload?.basis,
      posting_date: commitPayload?.posting_date,
      description: commitPayload?.description,
      journal_type: commitPayload?.journal_type,
      lines: commitPayload?.lines,
    });
    if (v.error) return { status: 400, body: { error: v.error } };

    // T11 D3 — reason REQUIRED on POST, exactly as the human handler.
    const reason = commitPayload?.reason ? String(commitPayload.reason).trim() : null;
    const reasonGate = requireReason("POST", reason);
    if (reasonGate) return { status: reasonGate.status, body: { error: reasonGate.error } };

    // The confirming operator is the MAKER. created_by = ctx.userId ⇒ decide()
    // refuses to let them approve their own request (self_approval_forbidden).
    const makerAuthId = ctx?.userId || null;
    const totalDebitCents = Number(sumDebitCents(v.data.lines));

    // Maker/checker gate — the EXACT ctx the human JE POST passes. If an active
    // rule matches the JE's total debits, hold the post and open an
    // approval_request instead of writing the ledger; the JE posts only once a
    // DIFFERENT authorized user approves (decide.js je_manual_post hook posts the
    // snapshotted payload). We do NOT lower or bypass the threshold.
    let gate;
    try {
      gate = await requestIfRequired(admin, {
        kind: "je_manual_post",
        entity_id: entityId,
        context_table: "journal_entries",
        // No JE row exists yet (posts only on approval). Synthetic id; the decide
        // hook rewrites context_id to the real JE id once posted.
        context_id: randomUUID(),
        amount_cents: totalDebitCents,
        currency: "USD",
        source_kind: "manual",
        payload: {
          entity_id: entityId,
          basis: v.data.basis,
          journal_type: v.data.journal_type || "manual",
          posting_date: v.data.posting_date,
          description: v.data.description,
          reason,
          lines: v.data.lines,
          total_debit_cents: String(totalDebitCents),
          created_by_user_id: makerAuthId,
        },
        created_by_user_id: makerAuthId,
      });
    } catch (e) {
      return { status: 500, body: { error: `Approval routing failed: ${e instanceof Error ? e.message : String(e)}` } };
    }

    if (gate.required) {
      return {
        status: 202,
        body: {
          requires_approval: true,
          approval_request_id: gate.request_id,
          status: "pending_approval",
          message:
            "This journal entry is at or above the approval threshold. It was submitted for approval — a different authorized user must approve it before it posts.",
        },
      };
    }

    // Below threshold — post immediately through the shared posting service
    // (identical to the human handler's below-threshold branch).
    const result = await postManualJournalEntry(admin, {
      entityId,
      data: v.data,
      reason,
      actor: { auth_id: makerAuthId, employee_id: null, display_name: null },
      correlation_id: null,
    });
    return { status: result.status, body: result.body };
  },
};

export default {
  key: "je_actions",
  label: "Journal entry actions",
  module_keys: ["je_post"],
  panels: {},
  actions: [draftManualJe],
};
