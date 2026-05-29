// api/_lib/shopify/post-order-cogs.js
//
// Tangerine P11-5 — Shopify per-line COGS posting service.
//
// Closes the gap left by P11-3 (which posts the AR/Revenue/Tax JE but
// explicitly defers COGS — see post-order-je.js header comment block).
//
// For each shopify_order_lines row with a resolved ip_item_master_id, this
// service drains FIFO inventory via `inventory_fifo_consume` (P3-3 RPC) and
// posts a single COGS JE on the order:
//
//   DR 5000 COGS       = Σ per-line cogs_cents
//   CR 1300 Inventory  = Σ per-line cogs_cents
//
// Why a separate JE (not the AR rule's indexed-mode consumePlan drain):
//   D5 from P11-shopify-architecture.md: the Shopify order webhook + AR JE
//   land at receipt-of-order without waiting for SKU→ip_item_master
//   resolution. P11-2 sets ip_item_master_id on shopify_order_lines best-effort
//   at upsert time; lines whose SKU has no master row stay NULL forever
//   (3P-only / unresolvable SKUs). Splitting AR from COGS lets the AR side
//   ship today even when the master mapping is incomplete.
//
// Idempotency:
//   - shopify_orders.cogs_je_id IS NOT NULL → already posted → return
//     { status: 'already_posted', je_id }.
//   - If no lines carry a resolvable ip_item_master_id (or all yield zero
//     cogs from FIFO), return { status: 'no_cogs' } and DO NOT touch
//     cogs_je_id. The next call after a master refresh / receiving event
//     can retry.
//
// Atomicity asymmetry (inherited from the existing AR-rule consumePlan path
// in arInvoiceSent.js — see that file's header). consume() mutates
// inventory_layers + inventory_consumption BEFORE the JE persists. If the
// gl_post_journal_entry RPC fails, the FIFO ledger leads GL by one event.
// Accepted tradeoff for symmetry with the P4 path.
//
// xlsx N/A — pure GL + inventory orchestration.

import { consume as consumeFifoDefault } from "../inventory/fifo.js";

const ZERO = 0n;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the GL accounts needed for the COGS post.
 *
 * Codes:
 *   5000 — COGS (P3-1 seed, required)
 *   1300 — Inventory asset (P3-1 seed, required)
 *
 * Returns { cogsId, inventoryId } — either can be null when the code is
 * missing on the entity's COA. Caller surfaces gl_accounts_missing.
 */
export async function resolveCogsAccounts(adminClient, entityId) {
  const { data, error } = await adminClient
    .from("gl_accounts")
    .select("id, code")
    .eq("entity_id", entityId)
    .in("code", ["5000", "1300"]);
  if (error) {
    throw new Error(`gl_accounts lookup failed: ${error.message}`);
  }
  const byCode = {};
  for (const row of data || []) byCode[row.code] = row.id;
  return {
    cogsId:      byCode["5000"] || null,
    inventoryId: byCode["1300"] || null,
  };
}

/**
 * Build the COGS JE payload from per-line consume results.
 *
 * @param {Object} args
 * @param {Object} args.order       shopify_orders row.
 * @param {Object} args.accounts    { cogsId, inventoryId }.
 * @param {Array<{
 *   line_id: string,
 *   ip_item_master_id: string,
 *   sku: string|null,
 *   quantity: number,
 *   cogs_cents: bigint,
 * }>} args.consumed   Per-line consume results (cogs_cents>0 only).
 * @returns {Object|null} payload for gl_post_journal_entry RPC, or null
 *   when the total is zero (no posting needed).
 */
export function buildCogsJePayload({ order, accounts, consumed }) {
  let totalCents = ZERO;
  for (const c of consumed) {
    if (c.cogs_cents > ZERO) totalCents += c.cogs_cents;
  }
  if (totalCents === ZERO) return null;

  const desc = `Shopify order ${order.order_number || order.shopify_order_id} — COGS`;
  const totalStr = centsToDecimal(totalCents);
  const lines = [];
  let lineNo = 0;

  // Per-line DR COGS pairs with per-item subledger tags. Aggregated CR
  // Inventory at the end keeps the JE compact while still letting auditors
  // trace each cogs back to its inventory item via subledger_id.
  for (const c of consumed) {
    if (c.cogs_cents <= ZERO) continue;
    const lineMemo =
      `COGS ${order.order_number || order.shopify_order_id}` +
      (c.sku ? ` — ${c.sku}` : "");
    lines.push({
      line_number: ++lineNo,
      account_id: accounts.cogsId,
      debit: centsToDecimal(c.cogs_cents),
      credit: "0",
      memo: lineMemo,
      subledger_type: "item",
      subledger_id: c.ip_item_master_id,
    });
  }

  // Single aggregated CR Inventory line — subledger_type=null since the
  // 1300 control account drains in aggregate.
  lines.push({
    line_number: ++lineNo,
    account_id: accounts.inventoryId,
    debit: "0",
    credit: totalStr,
    memo: desc,
    subledger_type: null,
    subledger_id: null,
  });

  return {
    entity_id: order.entity_id,
    basis: "ACCRUAL",
    journal_type: "ar_invoice_cogs",
    posting_date: toDateString(order.processed_at),
    source_module: "shopify",
    source_table: "shopify_orders",
    source_id: order.id,
    description: desc,
    sibling_je_id: order.je_id || null,
    created_by_user_id: null,
    lines,
  };
}

/**
 * Main entry point — post the COGS JE for a shopify_orders row.
 *
 * @param {Object} args
 * @param {string} args.shopifyOrderId      UUID of shopify_orders.id.
 * @param {Object} args.adminClient         Supabase service-role client.
 * @param {Object} [args.deps]              Test injection.
 *   @param {(client,args)=>Promise<{cogs_cents}>} [args.deps.consumeFifo]
 * @returns {Promise<
 *   {status:'already_posted', je_id:string} |
 *   {status:'no_cogs', reason:string} |
 *   {status:'posted', je_id:string, cogs_cents:string, lines:number}
 * >}
 */
export async function postShopifyOrderCogs({
  shopifyOrderId,
  adminClient,
  deps = {},
} = {}) {
  if (!shopifyOrderId || !UUID_RE.test(String(shopifyOrderId))) {
    throw new Error("shopifyOrderId must be a uuid");
  }
  if (!adminClient || typeof adminClient.from !== "function") {
    throw new Error("adminClient must be a Supabase client");
  }
  const consumeFifo = deps.consumeFifo || consumeFifoDefault;

  // 1. Read shopify_orders row.
  const { data: order, error: orderErr } = await adminClient
    .from("shopify_orders")
    .select("*")
    .eq("id", shopifyOrderId)
    .maybeSingle();
  if (orderErr) {
    throw new Error(`shopify_orders lookup failed: ${orderErr.message}`);
  }
  if (!order) {
    const e = new Error(`shopify_orders ${shopifyOrderId} not found`);
    e.code = "not_found";
    throw e;
  }

  // 2. Idempotency on cogs_je_id.
  if (order.cogs_je_id) {
    return { status: "already_posted", je_id: order.cogs_je_id };
  }

  // 3. Read lines. Only those with resolved ip_item_master_id are eligible.
  const { data: lines, error: linesErr } = await adminClient
    .from("shopify_order_lines")
    .select("id, line_number, sku, ip_item_master_id, quantity")
    .eq("shopify_order_id", shopifyOrderId);
  if (linesErr) {
    throw new Error(`shopify_order_lines lookup failed: ${linesErr.message}`);
  }
  const eligible = (lines || []).filter(
    (l) => l.ip_item_master_id && Number(l.quantity) > 0,
  );
  if (eligible.length === 0) {
    return {
      status: "no_cogs",
      reason: "no_eligible_lines",
    };
  }

  // 4. Resolve GL accounts.
  const accounts = await resolveCogsAccounts(adminClient, order.entity_id);
  const missing = [];
  if (!accounts.cogsId)      missing.push("5000 — COGS");
  if (!accounts.inventoryId) missing.push("1300 — Inventory");
  if (missing.length > 0) {
    const e = new Error(`Missing GL accounts: ${missing.join(", ")}`);
    e.code = "gl_accounts_missing";
    throw e;
  }

  // 5. Drain FIFO per eligible line. Track per-line errors so a single bad
  //    SKU (insufficient inventory most commonly) doesn't sink the whole
  //    order. We accumulate errors; if EVERY line errors we throw, otherwise
  //    we post a partial COGS JE and surface the errors in the return shape.
  const consumed = [];
  const lineErrors = [];
  for (const ln of eligible) {
    try {
      const { cogs_cents } = await consumeFifo(adminClient, {
        entity_id: order.entity_id,
        item_id: ln.ip_item_master_id,
        qty: Number(ln.quantity),
        consumer_kind: "ar_invoice",
        consumer_ref_id: ln.id,  // shopify_order_lines.id — per-line for refund symmetry
      });
      consumed.push({
        line_id: ln.id,
        ip_item_master_id: ln.ip_item_master_id,
        sku: ln.sku || null,
        quantity: Number(ln.quantity),
        cogs_cents,
      });
    } catch (e) {
      lineErrors.push({
        line_id: ln.id,
        sku: ln.sku || null,
        error: e instanceof Error ? e.message : String(e),
        code: e?.code || null,
      });
    }
  }

  if (consumed.length === 0) {
    // Every eligible line errored. Surface as a hard failure — the caller
    // (sender of postShopifyOrderJe's continuation, or the manual handler)
    // shows the operator what went wrong.
    const err = new Error(
      `COGS consume failed for all ${eligible.length} eligible lines on order ${shopifyOrderId}`,
    );
    err.code = "fifo_consume_failed";
    err.line_errors = lineErrors;
    throw err;
  }

  // 6. Build + post JE.
  const payload = buildCogsJePayload({ order, accounts, consumed });
  if (!payload) {
    // All cogs came back zero (the FIFO RPC returned 0n for every line).
    // This can happen when layers exist but unit_cost_cents=0 across all
    // drawn layers. Skip posting and report.
    return {
      status: "no_cogs",
      reason: "zero_aggregate_cogs",
      line_errors: lineErrors.length > 0 ? lineErrors : undefined,
    };
  }

  const { data: jeId, error: rpcErr } = await adminClient.rpc(
    "gl_post_journal_entry",
    { payload },
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

  // 7. Stamp shopify_orders.cogs_je_id.
  const { error: updErr } = await adminClient
    .from("shopify_orders")
    .update({ cogs_je_id: jeId })
    .eq("id", shopifyOrderId);
  if (updErr) {
    const e = new Error(
      `shopify_orders.cogs_je_id update failed (JE ${jeId} posted): ${updErr.message}`,
    );
    e.code = "shopify_orders_update_failed";
    e.je_id = jeId;
    throw e;
  }

  // 8. Best-effort per-line back-write of cogs_cents into shopify_order_lines.
  //    cogs_cents column may not exist (we did not add it in this chunk —
  //    arch lets the JE be the source of truth; the per-line back-write is
  //    a future P11-X if reporting needs it). Silently skip errors here.
  let backwriteFailed = false;
  for (const c of consumed) {
    if (c.cogs_cents <= ZERO) continue;
    const { error: lnErr } = await adminClient
      .from("shopify_order_lines")
      .update({ cogs_cents: c.cogs_cents.toString() })
      .eq("id", c.line_id);
    if (lnErr) {
      // Schema doesn't have the column — drop the attempt for the rest of
      // the loop; not fatal.
      backwriteFailed = true;
      break;
    }
  }

  // 9. Aggregate totals for the return shape.
  let totalCents = ZERO;
  for (const c of consumed) totalCents += c.cogs_cents;

  return {
    status: "posted",
    je_id: jeId,
    cogs_cents: totalCents.toString(),
    lines: consumed.length,
    line_errors: lineErrors.length > 0 ? lineErrors : undefined,
    line_cogs_backwrite_skipped: backwriteFailed || undefined,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Helpers (exported for unit tests).
// ────────────────────────────────────────────────────────────────────────

/**
 * BigInt cents → "123.45" decimal string. Mirror of the helper in
 * post-order-je.js; duplicated to keep COGS self-contained for testing.
 */
export function centsToDecimal(cents) {
  const c = typeof cents === "bigint" ? cents : BigInt(cents);
  const neg = c < ZERO;
  const abs = neg ? -c : c;
  const whole = abs / 100n;
  const frac = abs % 100n;
  return `${neg ? "-" : ""}${whole.toString()}.${frac.toString().padStart(2, "0")}`;
}

function toDateString(ts) {
  if (!ts) return new Date().toISOString().slice(0, 10);
  if (typeof ts === "string") return ts.slice(0, 10);
  if (ts instanceof Date) return ts.toISOString().slice(0, 10);
  return String(ts).slice(0, 10);
}
