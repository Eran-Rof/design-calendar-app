// api/_lib/shopify/process-dispute.js
//
// Tangerine P11-8 — Shopify dispute (chargeback) processing service.
//
// Pure(-ish) function: given a parsed Shopify dispute payload + a shop
// domain → resolve store, link to the parent shopify_orders row, post the
// chargeback JE atomically, open an M47 case, and INSERT the shopify_disputes
// row stamped with case_id + je_id.
//
// JE shape (per P11 arch D9):
//   DR 6610 Chargeback Expense = dispute_amount_cents
//   CR 1100 Bank               = dispute_amount_cents  (Shopify deducts the
//                                                       chargeback amount from
//                                                       the upcoming payout)
//
// Idempotency:
//   - shopify_disputes UNIQUE (shopify_store_id, shopify_dispute_id) — a
//     re-delivered webhook finds the row and returns
//     { status: 'already_processed', dispute_id }.
//   - The case + JE are only created when no row exists for the dispute id.
//
// source='shopify' is stamped on the shopify_disputes row per
// feedback_source_tagging_enforcement.
//
// BigInt cents throughout per project_tangerine_progress money handling.

const ZERO = 0n;

/**
 * Coerce a value into a BigInt cents amount. Accepts bigint / safe-integer
 * number / integer-cents string. Null / undefined / empty → 0n. Exported
 * for tests.
 */
export function toBigInt(v) {
  if (v == null || v === "") return ZERO;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || !Number.isInteger(v)) {
      throw new Error(`expected integer cents, got ${v}`);
    }
    return BigInt(v);
  }
  if (typeof v === "string") {
    if (!/^-?\d+$/.test(v)) {
      throw new Error(`expected integer-cents string, got ${v}`);
    }
    return BigInt(v);
  }
  throw new Error(`unsupported cents type: ${typeof v}`);
}

/**
 * BigInt cents → "123.45" decimal string (matches the gl_post_journal_entry
 * RPC payload format). Exported for tests.
 */
export function centsToDecimal(cents) {
  const c = typeof cents === "bigint" ? cents : toBigInt(cents);
  const neg = c < ZERO;
  const abs = neg ? -c : c;
  const whole = abs / 100n;
  const frac = abs % 100n;
  return `${neg ? "-" : ""}${whole.toString()}.${frac.toString().padStart(2, "0")}`;
}

/**
 * Convert a Shopify dollar string ("12.99") to integer cents (1299).
 * Returns 0 for null / undefined / empty / non-numeric. Exported for tests.
 */
export function dollarsToCents(v) {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/**
 * Normalize a Shopify dispute payload into the canonical shape we persist
 * on shopify_disputes. Exported for tests.
 *
 * Shopify dispute payloads carry: id, order_id, type ('chargeback'|'inquiry'),
 * amount (string dollars), currency, reason, status, evidence_due_by, ...
 */
export function buildDisputeRow({ payload, store, parentOrderId }) {
  const disputeId = String(payload.id ?? extractIdFromGid(payload.admin_graphql_api_id) ?? "");
  const type      = String(payload.type || "chargeback");
  const status    = String(payload.status || "needs_response");
  const amount    = dollarsToCents(payload.amount);
  return {
    entity_id: store.entity_id,
    shopify_store_id: store.id,
    shopify_order_id: parentOrderId || null,
    shopify_dispute_id: disputeId,
    dispute_type: type,
    dispute_amount_cents: amount,
    status,
    reason: payload.reason || null,
    evidence_due_by: payload.evidence_due_by || null,
    raw_payload: payload,
  };
}

/**
 * Build the gl_post_journal_entry RPC payload for a chargeback. Exported
 * for tests.
 *
 *   DR 6610 Chargeback Expense = amount
 *   CR 1100 Bank               = amount
 *
 * @param {Object} args
 * @param {Object} args.disputeRow  shopify_disputes-shaped row (entity_id +
 *                                  shopify_dispute_id + dispute_amount_cents).
 * @param {Object} args.accounts    { chargebackId, bankId }.
 */
export function buildChargebackJePayload({ disputeRow, accounts }) {
  const amount = toBigInt(disputeRow.dispute_amount_cents);
  if (amount <= ZERO) {
    throw new Error(
      `Shopify dispute ${disputeRow.shopify_dispute_id}: dispute_amount_cents must be > 0 (got ${amount})`,
    );
  }
  if (!accounts.chargebackId) {
    throw new Error(
      `Shopify dispute ${disputeRow.shopify_dispute_id}: missing 6610 Chargeback Expense account for entity ${disputeRow.entity_id}`,
    );
  }
  if (!accounts.bankId) {
    throw new Error(
      `Shopify dispute ${disputeRow.shopify_dispute_id}: missing 1100 Bank account for entity ${disputeRow.entity_id}`,
    );
  }

  const desc = `Shopify chargeback #${disputeRow.shopify_dispute_id}`;
  const lines = [
    {
      line_number: 1,
      account_id: accounts.chargebackId,
      debit: centsToDecimal(amount),
      credit: "0",
      memo: desc,
      subledger_type: null,
      subledger_id: null,
    },
    {
      line_number: 2,
      account_id: accounts.bankId,
      debit: "0",
      credit: centsToDecimal(amount),
      memo: `Bank deduction — ${desc}`,
      subledger_type: null,
      subledger_id: null,
    },
  ];
  return {
    entity_id: disputeRow.entity_id,
    basis: "ACCRUAL",
    journal_type: "chargeback",
    posting_date: new Date().toISOString().slice(0, 10),
    source_module: "shopify",
    source_table: "shopify_disputes",
    source_id: null,
    description: desc,
    sibling_je_id: null,
    created_by_user_id: null,
    lines,
  };
}

/**
 * Resolve the 6610 + 1100 GL account ids for an entity. Returns
 * { chargebackId, bankId } — either may be null when the seed is missing.
 * Exported for tests.
 */
export async function resolveDisputeGlAccounts(adminClient, entityId) {
  const { data, error } = await adminClient
    .from("gl_accounts")
    .select("id, code")
    .eq("entity_id", entityId)
    .in("code", ["6610", "1100"]);
  if (error) {
    throw new Error(`gl_accounts lookup failed: ${error.message}`);
  }
  const byCode = {};
  for (const row of data || []) byCode[row.code] = row.id;
  return {
    chargebackId: byCode["6610"] || null,
    bankId:       byCode["1100"] || null,
  };
}

/**
 * Build the cases POST body for a chargeback. Exported for tests.
 */
export function buildCaseBody({ disputeRow, customerId }) {
  const body = {
    subject: `Shopify chargeback #${disputeRow.shopify_dispute_id}`,
    body: [
      `Type: ${disputeRow.dispute_type}`,
      `Amount: ${centsToDecimal(toBigInt(disputeRow.dispute_amount_cents))}`,
      disputeRow.reason ? `Reason: ${disputeRow.reason}` : null,
      disputeRow.evidence_due_by ? `Evidence due by: ${disputeRow.evidence_due_by}` : null,
    ].filter(Boolean).join("\n"),
    status: "open",
    severity: "high",
  };
  if (customerId) body.customer_id = customerId;
  return body;
}

/**
 * Main entry point — process a single Shopify dispute webhook payload.
 *
 * Flow:
 *   1. Resolve store by shop domain.
 *   2. Look up parent shopify_orders row (by order_id).
 *   3. Dedup against shopify_disputes (UNIQUE store + dispute_id).
 *   4. Resolve 6610 / 1100 GL accounts.
 *   5. Build + post the chargeback JE via gl_post_journal_entry RPC.
 *   6. Open M47 case (POST /api/internal/cases via direct cases INSERT —
 *      using the same RPC-less path the cases handler uses).
 *   7. INSERT the shopify_disputes row with case_id + je_id stamped.
 *
 * @param {Object} args
 * @param {Object} args.payload         Parsed Shopify dispute payload.
 * @param {string} args.shopDomain      X-Shopify-Shop-Domain header value.
 * @param {Object} args.adminClient     Supabase service-role client.
 * @returns {Promise<
 *   {status:'already_processed', dispute_id:string, shopify_dispute_id:string} |
 *   {status:'ignored', reason:string} |
 *   {status:'processed', dispute_id:string, case_id:string, je_id:string}
 * >}
 */
export async function processShopifyDispute({ payload, shopDomain, adminClient }) {
  if (!payload || typeof payload !== "object") {
    throw new Error("payload is required");
  }
  if (!shopDomain) {
    throw new Error("shopDomain is required");
  }
  if (!adminClient || typeof adminClient.from !== "function") {
    throw new Error("adminClient must be a Supabase client");
  }

  // 1. Resolve store.
  const { data: store, error: storeErr } = await adminClient
    .from("shopify_stores")
    .select("id, entity_id")
    .eq("shopify_domain", shopDomain)
    .maybeSingle();
  if (storeErr) {
    throw new Error(`store lookup failed: ${storeErr.message}`);
  }
  if (!store) {
    return { status: "ignored", reason: "unknown_shop" };
  }

  // 2. Find parent shopify_orders row (if any). Shopify gives us the
  // numeric order id on payload.order_id (or extracted from a GID).
  const parentShopifyOrderId = String(
    payload.order_id ?? extractIdFromGid(payload.order?.admin_graphql_api_id) ?? "",
  );
  let parentOrder = null;
  if (parentShopifyOrderId) {
    const { data: ord, error: ordErr } = await adminClient
      .from("shopify_orders")
      .select("id, customer_id")
      .eq("shopify_store_id", store.id)
      .eq("shopify_order_id", parentShopifyOrderId)
      .maybeSingle();
    if (ordErr) {
      throw new Error(`shopify_orders lookup failed: ${ordErr.message}`);
    }
    parentOrder = ord || null;
  }

  // 3. Build the canonical row (without case_id / je_id — those are stamped
  // after the case + JE are created).
  const disputeRow = buildDisputeRow({
    payload,
    store,
    parentOrderId: parentOrder?.id || null,
  });
  if (!disputeRow.shopify_dispute_id) {
    throw new Error("dispute payload missing id");
  }

  // Dedup — return early if the dispute already exists.
  const { data: existing, error: existingErr } = await adminClient
    .from("shopify_disputes")
    .select("id, shopify_dispute_id")
    .eq("shopify_store_id", store.id)
    .eq("shopify_dispute_id", disputeRow.shopify_dispute_id)
    .maybeSingle();
  if (existingErr) {
    throw new Error(`shopify_disputes dedup lookup failed: ${existingErr.message}`);
  }
  if (existing) {
    return {
      status: "already_processed",
      dispute_id: existing.id,
      shopify_dispute_id: existing.shopify_dispute_id,
    };
  }

  // 4. Resolve GL accounts.
  const accounts = await resolveDisputeGlAccounts(adminClient, store.entity_id);
  const missing = [];
  if (!accounts.chargebackId) missing.push("6610 — Chargeback Expense");
  if (!accounts.bankId)       missing.push("1100 — Bank");
  if (missing.length > 0) {
    const e = new Error(`Missing GL accounts: ${missing.join(", ")}`);
    e.code = "gl_accounts_missing";
    throw e;
  }

  // 5. Post JE.
  const jePayload = buildChargebackJePayload({ disputeRow, accounts });
  const { data: jeId, error: rpcErr } = await adminClient.rpc(
    "gl_post_journal_entry",
    { payload: jePayload },
  );
  if (rpcErr) {
    const e = new Error(`gl_post_journal_entry RPC failed: ${rpcErr.message}`);
    e.code = "rpc_failed";
    e.cause = rpcErr;
    throw e;
  }
  if (typeof jeId !== "string") {
    throw new Error(
      `gl_post_journal_entry returned unexpected payload: ${JSON.stringify(jeId)}`,
    );
  }

  // 6. Open the M47 case. Generate case_number inline (mirror of the
  // nextCaseNumber helper in api/_handlers/internal/cases/index.js) so we
  // don't need to round-trip through HTTP — this runs in the same Vercel
  // function as the webhook intake.
  const customerId = parentOrder?.customer_id || null;
  const caseBody = buildCaseBody({ disputeRow, customerId });
  const caseNumber = await nextCaseNumber(adminClient, store.entity_id, new Date().getUTCFullYear());
  const { data: caseRow, error: caseErr } = await adminClient
    .from("cases")
    .insert({
      entity_id: store.entity_id,
      case_number: caseNumber,
      customer_id: customerId,
      status: caseBody.status,
      severity: caseBody.severity,
      subject: caseBody.subject,
      body: caseBody.body,
    })
    .select("id")
    .single();
  if (caseErr) {
    // JE posted but case insert failed — surface a recoverable error.
    // The dispute row has not been inserted yet so a retry of the whole
    // webhook will land on the dedup short-circuit only if the JE row's
    // source_id stamp races us; in practice the operator re-runs after
    // fixing the cases table (e.g. missing year sequence).
    const e = new Error(
      `cases insert failed (JE ${jeId} posted but case not opened): ${caseErr.message}`,
    );
    e.code = "case_insert_failed";
    e.je_id = jeId;
    throw e;
  }

  // 7. INSERT shopify_disputes row.
  const { data: dispute, error: dispErr } = await adminClient
    .from("shopify_disputes")
    .insert({
      ...disputeRow,
      case_id: caseRow.id,
      je_id: jeId,
    })
    .select("id")
    .single();
  if (dispErr) {
    // Race: another concurrent call inserted the same dispute id.
    const { data: retry } = await adminClient
      .from("shopify_disputes")
      .select("id, shopify_dispute_id")
      .eq("shopify_store_id", store.id)
      .eq("shopify_dispute_id", disputeRow.shopify_dispute_id)
      .maybeSingle();
    if (retry?.id) {
      return {
        status: "already_processed",
        dispute_id: retry.id,
        shopify_dispute_id: retry.shopify_dispute_id,
      };
    }
    const e = new Error(
      `shopify_disputes insert failed (JE ${jeId} + case ${caseRow.id} posted): ${dispErr.message}`,
    );
    e.code = "shopify_disputes_insert_failed";
    e.je_id = jeId;
    e.case_id = caseRow.id;
    throw e;
  }

  return {
    status: "processed",
    dispute_id: dispute.id,
    case_id: caseRow.id,
    je_id: jeId,
  };
}

/**
 * Generate the next CASE-YYYY-NNNNN case_number for an entity. Mirror of
 * the helper in api/_handlers/internal/cases/index.js so this service can
 * INSERT cases directly without an HTTP round-trip. Exported for tests.
 */
export async function nextCaseNumber(adminClient, entityId, year) {
  const prefix = `CASE-${year}-`;
  const { data } = await adminClient
    .from("cases")
    .select("case_number")
    .eq("entity_id", entityId)
    .like("case_number", `${prefix}%`)
    .order("case_number", { ascending: false })
    .limit(1);
  let next = 1;
  if (Array.isArray(data) && data.length > 0) {
    const last = data[0].case_number;
    const m = /^CASE-\d{4}-(\d+)$/.exec(last || "");
    if (m) next = parseInt(m[1], 10) + 1;
  }
  return `${prefix}${String(next).padStart(5, "0")}`;
}

function extractIdFromGid(gid) {
  if (!gid || typeof gid !== "string") return null;
  const parts = gid.split("/");
  const tail = parts[parts.length - 1];
  return tail || null;
}
