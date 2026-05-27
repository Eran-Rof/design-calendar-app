// api/_lib/accounting/posting/rules/arPaymentReceived.js
//
// Customer payment received (P4-2; arch §4.2).
//
// Accrual: DR bank_account / CR ar_account (per-application)
//          Clears the customer's AR balance on the applied invoices.
// Cash:    DR bank_account / CR revenue_account (per-application)
//          Cash basis recognizes revenue at PAYMENT RECEIPT time (deferred
//          from invoice send — the AR-side analogue of the AP cash twin
//          recognizing expense at AP PAYMENT, not at bill receipt).
//
// Two payload shapes supported (parallel to apInvoiceReceived's evolution):
//   1. Single-application (legacy / on-account): event.data.amount +
//      ar_account_id + revenue_account_id + cash_account_id.
//      Produces ONE accrual + ONE cash JE, each with two lines.
//   2. Multi-application (P4-2): event.data.applications = [{
//        ar_invoice_id, ar_account_id, revenue_account_id, amount_cents
//      }]. Produces ONE accrual + ONE cash JE per receipt, each with
//      (1 + N) lines: the bank DR header + N per-invoice CR lines.

/**
 * @param {import('../types.js').PostingEvent} event
 *   event.data = {
 *     receipt_id: string,
 *     customer_id: string,
 *     receipt_date: 'YYYY-MM-DD',
 *     bank_account_id: string,           // P4-2 normalized name (was cash_account_id)
 *     cash_account_id?: string,          // legacy alias for bank_account_id
 *     // Single-application path (legacy):
 *     invoice_id?: string,
 *     amount?: string,
 *     ar_account_id?: string,
 *     revenue_account_id?: string,
 *     payment_reference?: string,
 *     // Multi-application path (P4-2):
 *     applications?: Array<{
 *       ar_invoice_id: string,
 *       ar_account_id: string,           // resolved from the invoice's ar_account_id
 *       revenue_account_id: string,      // resolved from the invoice's revenue_account_id (per-line default split)
 *       amount_cents: number|string|bigint,
 *       invoice_number?: string,         // optional, for memo
 *     }>,
 *     total_amount_cents?: number|string|bigint,  // sanity check; sums applications
 *   }
 *   event.bypass_period_lock?: boolean   // only honored for journal_type='ar_receipt_historical'
 * @returns {import('../types.js').PostingRuleOutput}
 */
export function arPaymentReceived(event) {
  const d = event.data;
  required(d, ["receipt_id", "customer_id", "receipt_date"]);

  const bankAccountId = d.bank_account_id || d.cash_account_id;
  if (!bankAccountId) {
    throw new Error(
      `arPaymentReceived: data.bank_account_id (or cash_account_id) is required`,
    );
  }

  const useMultiApp = Array.isArray(d.applications) && d.applications.length > 0;
  const journalType = d.journal_type || "ar_receipt";
  const bypassPeriodLock = event.bypass_period_lock === true;

  if (!useMultiApp) {
    return buildSingleApplicationOutput(event, d, bankAccountId, journalType, bypassPeriodLock);
  }
  return buildMultiApplicationOutput(event, d, bankAccountId, journalType, bypassPeriodLock);
}

function buildSingleApplicationOutput(event, d, bankAccountId, journalType, bypassPeriodLock) {
  required(d, ["amount", "ar_account_id", "revenue_account_id"]);
  const desc = d.invoice_id
    ? `AR receipt for invoice ${d.invoice_id}${d.payment_reference ? ` (${d.payment_reference})` : ""}`
    : `AR receipt — on-account${d.payment_reference ? ` (${d.payment_reference})` : ""}`;

  const accrual = {
    entity_id: event.entity_id,
    basis: "ACCRUAL",
    journal_type: journalType,
    posting_date: d.receipt_date,
    source_module: "ar",
    source_table: "ar_receipts",
    source_id: d.receipt_id,
    description: desc,
    created_by_user_id: event.created_by_user_id ?? null,
    bypass_period_lock: bypassPeriodLock,
    lines: [
      {
        line_number: 1,
        account_id: bankAccountId,
        debit: d.amount,
        credit: "0",
        memo: desc,
        subledger_type: null,
        subledger_id: null,
      },
      {
        line_number: 2,
        account_id: d.ar_account_id,
        debit: "0",
        credit: d.amount,
        memo: desc,
        subledger_type: "customer",
        subledger_id: d.customer_id,
      },
    ],
  };

  const cash = {
    entity_id: event.entity_id,
    basis: "CASH",
    journal_type: journalType,
    posting_date: d.receipt_date,
    source_module: "ar",
    source_table: "ar_receipts",
    source_id: d.receipt_id,
    description: desc,
    created_by_user_id: event.created_by_user_id ?? null,
    bypass_period_lock: bypassPeriodLock,
    lines: [
      {
        line_number: 1,
        account_id: bankAccountId,
        debit: d.amount,
        credit: "0",
        memo: desc,
        subledger_type: null,
        subledger_id: null,
      },
      {
        line_number: 2,
        account_id: d.revenue_account_id,
        debit: "0",
        credit: d.amount,
        memo: desc,
        subledger_type: null,
        subledger_id: null,
      },
    ],
  };

  return { accrual, cash };
}

function buildMultiApplicationOutput(event, d, bankAccountId, journalType, bypassPeriodLock) {
  const desc = `AR receipt ${d.receipt_id}${d.payment_reference ? ` (${d.payment_reference})` : ""}`;

  // Validate every application + sum to verify totals.
  let totalCents = 0n;
  for (let i = 0; i < d.applications.length; i++) {
    const app = d.applications[i];
    if (!app || !app.ar_invoice_id) {
      throw new Error(`arPaymentReceived: applications[${i}].ar_invoice_id is required`);
    }
    if (!app.ar_account_id) {
      throw new Error(`arPaymentReceived: applications[${i}].ar_account_id is required`);
    }
    if (!app.revenue_account_id) {
      throw new Error(`arPaymentReceived: applications[${i}].revenue_account_id is required`);
    }
    if (app.amount_cents == null || app.amount_cents === "") {
      throw new Error(`arPaymentReceived: applications[${i}].amount_cents is required`);
    }
    const cents = toBigIntCents(app.amount_cents, `applications[${i}].amount_cents`);
    if (cents <= 0n) {
      throw new Error(`arPaymentReceived: applications[${i}].amount_cents must be > 0`);
    }
    totalCents += cents;
  }

  // Optional payload-level total cross-check.
  if (d.total_amount_cents != null && d.total_amount_cents !== "") {
    const declared = toBigIntCents(d.total_amount_cents, "total_amount_cents");
    if (declared !== totalCents) {
      throw new Error(
        `arPaymentReceived: total_amount_cents (${declared}) does not equal sum of applications (${totalCents})`,
      );
    }
  }

  const totalStr = fromCents(totalCents);

  // Accrual: DR bank header + per-app CR ar_account
  const accrualLines = [
    {
      line_number: 1,
      account_id: bankAccountId,
      debit: totalStr,
      credit: "0",
      memo: desc,
      subledger_type: null,
      subledger_id: null,
    },
  ];
  for (let i = 0; i < d.applications.length; i++) {
    const app = d.applications[i];
    const cents = toBigIntCents(app.amount_cents, `applications[${i}].amount_cents`);
    const invLabel = app.invoice_number || app.ar_invoice_id;
    accrualLines.push({
      line_number: i + 2,
      account_id: app.ar_account_id,
      debit: "0",
      credit: fromCents(cents),
      memo: `${desc} → invoice ${invLabel}`,
      subledger_type: "customer",
      subledger_id: d.customer_id,
    });
  }

  // Cash: DR bank header + per-app CR revenue
  const cashLines = [
    {
      line_number: 1,
      account_id: bankAccountId,
      debit: totalStr,
      credit: "0",
      memo: desc,
      subledger_type: null,
      subledger_id: null,
    },
  ];
  for (let i = 0; i < d.applications.length; i++) {
    const app = d.applications[i];
    const cents = toBigIntCents(app.amount_cents, `applications[${i}].amount_cents`);
    const invLabel = app.invoice_number || app.ar_invoice_id;
    cashLines.push({
      line_number: i + 2,
      account_id: app.revenue_account_id,
      debit: "0",
      credit: fromCents(cents),
      memo: `${desc} → invoice ${invLabel}`,
      subledger_type: null,
      subledger_id: null,
    });
  }

  const base = {
    entity_id: event.entity_id,
    journal_type: journalType,
    posting_date: d.receipt_date,
    source_module: "ar",
    source_table: "ar_receipts",
    source_id: d.receipt_id,
    description: desc,
    created_by_user_id: event.created_by_user_id ?? null,
    bypass_period_lock: bypassPeriodLock,
  };

  return {
    accrual: { ...base, basis: "ACCRUAL", lines: accrualLines },
    cash:    { ...base, basis: "CASH",    lines: cashLines },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────────────

function required(obj, fields) {
  for (const f of fields) {
    if (obj?.[f] == null || obj[f] === "") {
      throw new Error(`arPaymentReceived: data.${f} is required`);
    }
  }
}

function toBigIntCents(v, name) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || !Number.isInteger(v)) {
      throw new Error(`arPaymentReceived: ${name} must be integer cents (got ${v})`);
    }
    return BigInt(v);
  }
  if (typeof v === "string") {
    if (!/^-?\d+$/.test(v)) {
      throw new Error(`arPaymentReceived: ${name} must be integer cents string (got ${v})`);
    }
    return BigInt(v);
  }
  throw new Error(`arPaymentReceived: ${name} must be number|string|bigint (got ${typeof v})`);
}

function fromCents(cents) {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const whole = abs / 100n;
  const frac = abs % 100n;
  const fracStr = frac.toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole.toString()}.${fracStr}`;
}
