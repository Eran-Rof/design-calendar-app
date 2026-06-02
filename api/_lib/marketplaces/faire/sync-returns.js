// api/_lib/marketplaces/faire/sync-returns.js
//
// Tangerine P12c-4 — Faire wholesale returns ingest + AR credit-memo
// posting + warehouse restock JE service.
//
// Faire is wholesale, so returns come back to the seller's warehouse
// always — no FBA-style marketplace-fulfillment carve-out. A return that
// has reached the refunded state means:
//
//   1. Faire has deducted the refund from the buyer's next payout (or
//      issued a chargeback from a closed payout) — accounting impact on
//      our side is an AR credit memo reducing the customer's receivable
//      and reversing the revenue we recognized at order time.
//   2. The goods have physically returned to our warehouse — accounting
//      impact is a restock layer at the FIFO cost of the latest open
//      layer for the returned item, plus a JE crediting COGS for the
//      reversed cost.
//
// Wholesale returns rarely break down by line. Faire's payload is item-
// level when available; when only refund_amount_cents is given (no
// item_token breakdown), we fall back to a single "miscellaneous refund"
// credit-memo line keyed off the underlying faire_order row's customer.
//
// Per-shop try/catch — one broken shop doesn't sink the rest. Returns a
// summary:
//
//   { shops_scanned, returns_upserted_total, returns_posted_total,
//     errors:[...], per_shop:[...] }
//
// The cron at /api/cron/faire-returns-weekly fires this Monday 05:30 UTC.
// The manual trigger at /api/internal/faire/sync-returns reuses it.

import { FaireClient, FaireApiError } from "./client.js";
import { decryptToken } from "./token-encryption.js";

const LOOKBACK_DAYS = 30;
const PAGE_SIZE = 50;
const SAFETY_PAGE_CAP = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Faire return states that mean "money is back in the buyer's pocket" and
// therefore we owe a credit memo + warehouse restock. Other states like
// REQUESTED / APPROVED / RECEIVED are tracked but not yet booked.
const POSTABLE_STATES = new Set([
  "REFUNDED",
  "REFUND_PROCESSED",
  "COMPLETED",
  "CLOSED",
]);

/**
 * Compute the per-shop lookback floor for the /returns poll:
 *   updated_at_min = max(last_returns_sync_at, now - 30 days)
 *
 * faire_shops has no `last_returns_sync_at` column today — until the next
 * schema bump adds one, we always start from now - 30 days. The since
 * override still applies. Exported for tests.
 */
export function computeReturnsUpdatedAtMin(lastSyncAt, sinceOverride, nowMs = Date.now()) {
  if (sinceOverride) return sinceOverride;
  const floor = new Date(nowMs - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  if (!lastSyncAt) return floor.toISOString();
  const lastMs = new Date(lastSyncAt).getTime();
  if (!Number.isFinite(lastMs) || lastMs < floor.getTime()) return floor.toISOString();
  return new Date(lastMs).toISOString();
}

/**
 * Coerce a Faire money value to integer cents. Identical rule to the
 * other Faire sync modules so behaviour matches.
 *
 * Exported for tests.
 */
export function toCents(value) {
  if (value == null) return 0;
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return 0;
  if (Math.floor(num) !== num) return Math.round(num * 100);
  return Math.round(num);
}

/**
 * Pick the first non-empty Faire return id field. Faire's payload exposes
 * the canonical id under different keys depending on API version.
 *
 * Exported for tests.
 */
export function extractFaireReturnId(payload) {
  if (!payload || typeof payload !== "object") return null;
  const v =
    payload.id ||
    payload.return_id ||
    payload.faire_return_id ||
    payload.return_token ||
    null;
  return v ? String(v) : null;
}

/**
 * Pull the faire-side order id off a return payload — Faire links each
 * return to the originating order via order_id (or its variants).
 *
 * Exported for tests.
 */
export function extractFaireOrderRef(payload) {
  if (!payload || typeof payload !== "object") return null;
  const v =
    payload.order_id ||
    payload.faire_order_id ||
    payload.order_token ||
    null;
  return v ? String(v) : null;
}

/**
 * Normalise the return status string. Faire occasionally lower-cases
 * values; we upper-case for the POSTABLE_STATES match + storage.
 *
 * Exported for tests.
 */
export function normaliseStatus(payload) {
  const raw = payload?.status || payload?.state || payload?.return_status || "UNKNOWN";
  return String(raw).toUpperCase();
}

/**
 * Sum a Faire return payload's refund/credit amount across the variants
 * Faire exposes (top-level refund_amount, refund_amount_cents,
 * total_refund_cents, or per-line item totals).
 *
 * Exported for tests.
 */
export function sumRefundCents(payload) {
  if (!payload || typeof payload !== "object") return 0;
  if (payload.refund_amount_cents != null) return toCents(payload.refund_amount_cents);
  if (payload.total_refund_cents != null) return toCents(payload.total_refund_cents);
  if (payload.refund_amount != null) return toCents(payload.refund_amount);
  if (payload.total_refund != null) return toCents(payload.total_refund);

  // Fall back to line-item rollup.
  const items = Array.isArray(payload.items) ? payload.items
              : Array.isArray(payload.return_items) ? payload.return_items
              : Array.isArray(payload.lines) ? payload.lines
              : [];
  let total = 0;
  for (const it of items) {
    if (it == null) continue;
    if (it.refund_amount_cents != null) { total += toCents(it.refund_amount_cents); continue; }
    if (it.refund_amount != null)        { total += toCents(it.refund_amount); continue; }
    if (it.line_total_cents != null)     { total += toCents(it.line_total_cents); continue; }
    if (it.line_total != null)           { total += toCents(it.line_total); continue; }
  }
  return total;
}

/**
 * @param {Object} supabase  service-role client
 * @param {Object} [opts]
 * @param {string} [opts.onlyShopId]    only run a single shop
 * @param {string} [opts.sinceOverride] override updated_at_min
 * @param {Object} [opts.deps]          injection point for tests:
 *                                      { makeClient, decryptToken, now,
 *                                        postCreditMemo }
 */
export async function runFaireReturnsIngest(supabase, opts = {}) {
  const deps = {
    makeClient: (apiKey) => new FaireClient({ apiKey }),
    decryptToken,
    now: () => Date.now(),
    postCreditMemo: defaultPostCreditMemo,
    ...(opts.deps || {}),
  };

  let q = supabase
    .from("faire_shops")
    .select("id, entity_id, shop_name, api_key_ciphertext, api_key_iv, api_key_tag, last_returns_sync_at")
    .eq("is_active", true)
    .not("api_key_ciphertext", "is", null);
  if (opts.onlyShopId) {
    if (!UUID_RE.test(opts.onlyShopId)) {
      throw new Error("onlyShopId must be a uuid");
    }
    q = q.eq("id", opts.onlyShopId);
  }

  const { data: shops, error: sErr } = await q;
  if (sErr) throw new Error(`faire_shops read failed: ${sErr.message}`);

  const summary = {
    shops_scanned: 0,
    returns_upserted_total: 0,
    returns_posted_total: 0,
    errors: [],
    per_shop: [],
  };

  for (const shop of shops || []) {
    summary.shops_scanned += 1;
    const shopSummary = {
      faire_shop_id: shop.id,
      shop_name: shop.shop_name,
      returns_upserted: 0,
      returns_posted: 0,
      pages_walked: 0,
      cursor_updated: false,
      error: null,
      post_errors: [],
    };
    summary.per_shop.push(shopSummary);

    try {
      await ingestShopReturns(supabase, shop, opts, deps, shopSummary);
    } catch (e) {
      const msg = e instanceof FaireApiError
        ? `Faire ${e.status}: ${e.message}`
        : (e instanceof Error ? e.message : String(e));
      shopSummary.error = msg;
      summary.errors.push(`faire_shop ${shop.id}: ${msg}`);
    }

    summary.returns_upserted_total += shopSummary.returns_upserted;
    summary.returns_posted_total   += shopSummary.returns_posted;
  }

  return summary;
}

async function ingestShopReturns(supabase, shop, opts, deps, shopSummary) {
  const apiKey = deps.decryptToken(
    shop.api_key_ciphertext,
    shop.api_key_iv,
    shop.api_key_tag,
  );
  const client = deps.makeClient(apiKey);
  const updatedAtMin = computeReturnsUpdatedAtMin(
    shop.last_returns_sync_at,
    opts.sinceOverride,
    deps.now(),
  );

  let page = 1;
  let safety = 0;
  while (safety < SAFETY_PAGE_CAP) {
    safety += 1;
    shopSummary.pages_walked = safety;
    const { data: returns, hasNextPage } = await client.listReturns({
      updatedAtMin, limit: PAGE_SIZE, page,
    });
    for (const ret of returns || []) {
      await ingestOneReturn(supabase, shop, ret, opts, deps, shopSummary);
    }
    if (!hasNextPage) break;
    page += 1;
  }

  // Cursor stamp — best-effort (only if the column exists; safe upsert
  // shape). On a Supabase schema that lacks last_returns_sync_at this
  // becomes a no-op-equivalent error we don't propagate.
  const cursorPatch = {
    updated_at: new Date(deps.now()).toISOString(),
  };
  cursorPatch.last_returns_sync_at = new Date(deps.now()).toISOString();
  const { error: cErr } = await supabase
    .from("faire_shops")
    .update(cursorPatch)
    .eq("id", shop.id);
  if (cErr && !/column .* does not exist/i.test(cErr.message || "")) {
    throw new Error(`last_returns_sync_at update failed: ${cErr.message}`);
  }
  shopSummary.cursor_updated = !cErr;
}

async function ingestOneReturn(supabase, shop, payload, opts, deps, shopSummary) {
  const faireReturnId = extractFaireReturnId(payload);
  if (!faireReturnId) return; // skip malformed rows rather than throwing

  const faireOrderRef = extractFaireOrderRef(payload);
  let faireOrderRowId = null;
  if (faireOrderRef) {
    const { data: orderRow, error: oErr } = await supabase
      .from("faire_orders")
      .select("id")
      .eq("faire_shop_id", shop.id)
      .eq("faire_order_id", faireOrderRef)
      .maybeSingle();
    if (oErr) throw new Error(`faire_orders lookup failed: ${oErr.message}`);
    faireOrderRowId = orderRow?.id || null;
  }

  const status = normaliseStatus(payload);
  const refundCents = sumRefundCents(payload);
  const reason = payload.reason || payload.return_reason || null;

  const row = {
    entity_id: shop.entity_id,
    faire_shop_id: shop.id,
    faire_order_id: faireOrderRowId,
    faire_return_id: faireReturnId,
    return_status: status,
    refund_amount_cents: refundCents,
    reason: reason ? String(reason) : null,
    raw_payload: payload,
    source: "faire",
  };

  const { data: upserted, error: upErr } = await supabase
    .from("faire_returns")
    .upsert(row, { onConflict: "faire_shop_id,faire_return_id" })
    .select("id, je_id, ar_credit_memo_id, faire_order_id")
    .maybeSingle();
  if (upErr || !upserted) {
    throw new Error(`faire_returns upsert failed for ${faireReturnId}: ${upErr?.message || "no row"}`);
  }
  shopSummary.returns_upserted += 1;

  // Decide whether to post. Only post when (a) the state is postable
  // (REFUNDED-equivalent), (b) we haven't already (je_id NULL), and
  // (c) we have a refund amount to book.
  if (!POSTABLE_STATES.has(status)) return;
  if (upserted.je_id) return;
  if (refundCents <= 0) return;
  if (!faireOrderRowId) return;  // can't credit a buyer we never invoiced

  try {
    const result = await deps.postCreditMemo({
      supabase,
      faireReturnsRow: { ...row, id: upserted.id },
      faireOrderRowId,
    });
    if (result?.status === "posted" || result?.status === "already_posted") {
      shopSummary.returns_posted += 1;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    shopSummary.post_errors.push(`faire_returns ${faireReturnId}: ${msg}`);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Default credit-memo poster.
//
// Wraps gl_post_journal_entry directly with a credit-memo shape. We
// keep this co-located with the sync rather than splitting into a
// separate post-return-je file because (a) Faire-wholesale returns are
// always whole-amount refunds without per-line cost breakdowns (b) the
// inventory layer creation is best-effort and skipped if we can't
// resolve the underlying item (no item_id on the payload, no
// ip_item_master link on the source line).
// ────────────────────────────────────────────────────────────────────────

/**
 * Default credit-memo poster — exported for tests + swap.
 *
 * Shape (per arch §4.4 + arCreditMemo rule):
 *   CR 1115 Marketplace Receivable Clearing   (reduces receivable)
 *   DR 4000 Revenue                            (reverses revenue)
 *   [DR 1300 Inventory / CR 5000 COGS]        (per restock line — when
 *                                              we can resolve the item)
 *
 * 1115 is the same Marketplace Receivable Clearing account used by the
 * P12c-3 order JE — that's the AR posting Faire orders. The credit
 * memo nets against that same balance.
 *
 * @param {Object} args
 * @param {Object} args.supabase
 * @param {Object} args.faireReturnsRow      faire_returns row (with id).
 * @param {string} args.faireOrderRowId      faire_orders.id we're crediting.
 * @returns {Promise<{status:'posted'|'already_posted', je_id:string, ar_credit_memo_id?:string}>}
 */
export async function defaultPostCreditMemo({ supabase, faireReturnsRow, faireOrderRowId }) {
  // 1. Re-read the row to confirm idempotency window.
  const { data: fr, error: frErr } = await supabase
    .from("faire_returns")
    .select("id, entity_id, faire_shop_id, faire_return_id, refund_amount_cents, je_id, ar_credit_memo_id, raw_payload")
    .eq("id", faireReturnsRow.id)
    .maybeSingle();
  if (frErr) throw new Error(`faire_returns re-read failed: ${frErr.message}`);
  if (!fr) throw new Error(`faire_returns ${faireReturnsRow.id} disappeared`);
  if (fr.je_id) return { status: "already_posted", je_id: fr.je_id };

  // 2. Load the originating order (for customer_id + invoice link).
  const { data: order, error: oErr } = await supabase
    .from("faire_orders")
    .select("id, entity_id, faire_order_id, customer_id, ar_invoice_id, placed_at")
    .eq("id", faireOrderRowId)
    .maybeSingle();
  if (oErr) throw new Error(`faire_orders read failed: ${oErr.message}`);
  if (!order) throw new Error(`faire_orders ${faireOrderRowId} not found`);
  if (!order.customer_id) {
    throw new Error(`faire_orders ${faireOrderRowId} has no customer_id — post P12c-3 first`);
  }

  // 3. Resolve GL accounts: 1115 (AR clearing), 4000 (revenue),
  //    1300 (inventory), 5000 (cogs).
  const codes = ["1115", "4000", "1300", "5000"];
  const { data: glRows, error: gErr } = await supabase
    .from("gl_accounts")
    .select("id, code")
    .eq("entity_id", fr.entity_id)
    .in("code", codes);
  if (gErr) throw new Error(`gl_accounts lookup failed: ${gErr.message}`);
  const byCode = {};
  for (const r of glRows || []) byCode[r.code] = r.id;
  const arId      = byCode["1115"];
  const revenueId = byCode["4000"];
  if (!arId)      throw new Error("Missing GL 1115 (Marketplace Receivable Clearing)");
  if (!revenueId) throw new Error("Missing GL 4000 (Revenue)");

  const refundCents = Number(fr.refund_amount_cents || 0);
  if (refundCents <= 0) {
    throw new Error(`refund_amount_cents must be > 0 (got ${refundCents})`);
  }

  // 4. Build JE payload — credit memo header.
  const postingDate = toDateString(order.placed_at);
  const desc = `Faire return ${fr.faire_return_id} — credit memo`;

  const lines = [];
  let lineNo = 0;

  // CR 1115 receivable
  lines.push({
    line_number: ++lineNo,
    account_id: arId,
    debit: "0",
    credit: centsToDecimal(refundCents),
    memo: desc,
    subledger_type: "customer",
    subledger_id: order.customer_id,
  });
  // DR 4000 revenue (reverses revenue recognized at order time)
  lines.push({
    line_number: ++lineNo,
    account_id: revenueId,
    debit: centsToDecimal(refundCents),
    credit: "0",
    memo: desc,
    subledger_type: null,
    subledger_id: null,
  });

  // Inventory restock pair — best-effort; only when the payload exposes
  // ip_item_master ids + qty + a resolved unit cost via FIFO.
  const restocks = await buildRestockPairs({
    supabase,
    entityId: fr.entity_id,
    payload: fr.raw_payload,
    inventoryId: byCode["1300"],
    cogsId: byCode["5000"],
    desc,
  });
  for (const ln of restocks.lines) {
    lines.push({ ...ln, line_number: ++lineNo });
  }

  const jePayload = {
    entity_id: fr.entity_id,
    basis: "ACCRUAL",
    journal_type: "ar_credit_memo",
    posting_date: postingDate,
    source_module: "faire",
    source_table: "faire_returns",
    source_id: fr.id,
    description: desc,
    sibling_je_id: null,
    created_by_user_id: null,
    lines,
  };

  // 5. Post the JE.
  const { data: jeId, error: rpcErr } = await supabase.rpc(
    "gl_post_journal_entry",
    { payload: jePayload },
  );
  if (rpcErr) throw new Error(`gl_post_journal_entry RPC failed: ${rpcErr.message}`);
  if (typeof jeId !== "string") {
    throw new Error(`gl_post_journal_entry returned ${JSON.stringify(jeId)}`);
  }

  // 6. Write the inventory_layers restock rows.
  for (const layer of restocks.layers) {
    const { error: lErr } = await supabase.from("inventory_layers").insert({
      entity_id: fr.entity_id,
      item_id: layer.item_id,
      received_at: postingDate,
      original_qty: layer.qty,
      remaining_qty: layer.qty,
      unit_cost_cents: layer.unit_cost_cents,
      source_kind: "credit_memo_return",
      notes: `Faire return ${fr.faire_return_id} restock`,
    });
    if (lErr) {
      // Don't fail the whole post; surface via console for follow-up.
      // eslint-disable-next-line no-console
      console.warn(`inventory_layers insert failed: ${lErr.message}`);
    }
  }

  // 7. Insert ar_invoices credit memo row.
  const { data: cm, error: cmErr } = await supabase
    .from("ar_invoices")
    .insert({
      entity_id: fr.entity_id,
      customer_id: order.customer_id,
      invoice_number: `FAIRE-CM-${fr.faire_return_id}`,
      invoice_kind: "customer_credit_memo",
      gl_status: "posted",
      invoice_date: postingDate,
      ar_account_id: arId,
      revenue_account_id: revenueId,
      accrual_je_id: jeId,
      total_amount_cents: String(refundCents),
      paid_amount_cents: "0",
      reverses_invoice_id: order.ar_invoice_id || null,
      source: "faire",
    })
    .select("id")
    .single();
  if (cmErr) {
    // JE is posted; stamp je_id so the row isn't double-posted.
    await supabase
      .from("faire_returns")
      .update({ je_id: jeId })
      .eq("id", fr.id);
    throw new Error(`ar_invoices credit-memo insert failed (JE ${jeId} posted): ${cmErr.message}`);
  }

  // 8. Stamp the faire_returns row.
  const { error: upErr } = await supabase
    .from("faire_returns")
    .update({ je_id: jeId, ar_credit_memo_id: cm.id })
    .eq("id", fr.id);
  if (upErr) {
    throw new Error(`faire_returns stamp failed (JE ${jeId}, CM ${cm.id} posted): ${upErr.message}`);
  }

  return { status: "posted", je_id: jeId, ar_credit_memo_id: cm.id };
}

/**
 * Build the DR inventory / CR cogs JE pair + the inventory_layers rows
 * for each restock-able line on the return payload. Skips lines whose
 * item cannot be resolved to ip_item_master + that have no resolvable
 * latest open layer cost.
 *
 * Exported for tests.
 */
export async function buildRestockPairs({ supabase, entityId, payload, inventoryId, cogsId, desc }) {
  const lines = [];
  const layers = [];

  if (!inventoryId || !cogsId) return { lines, layers };

  const items = Array.isArray(payload?.items) ? payload.items
              : Array.isArray(payload?.return_items) ? payload.return_items
              : Array.isArray(payload?.lines) ? payload.lines
              : [];
  if (items.length === 0) return { lines, layers };

  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const qty = Number(it.quantity ?? it.qty ?? 0);
    if (!Number.isFinite(qty) || qty <= 0) continue;

    const sku = it.sku || it.product_sku || it.variant_sku || null;
    if (!sku) continue;

    // Resolve item_id via sku → ip_item_master.
    const { data: item, error: iErr } = await supabase
      .from("ip_item_master")
      .select("id")
      .eq("entity_id", entityId)
      .eq("sku", sku)
      .maybeSingle();
    if (iErr || !item?.id) continue;

    // Resolve unit cost from latest open inventory_layer (FIFO recent).
    const { data: layer, error: lErr } = await supabase
      .from("inventory_layers")
      .select("unit_cost_cents")
      .eq("entity_id", entityId)
      .eq("item_id", item.id)
      .gt("remaining_qty", 0)
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lErr || !layer?.unit_cost_cents) continue;

    const unitCostCents = Number(layer.unit_cost_cents);
    const totalCostCents = Math.round(unitCostCents * qty);
    if (totalCostCents <= 0) continue;

    lines.push({
      account_id: inventoryId,
      debit: centsToDecimal(totalCostCents),
      credit: "0",
      memo: `${desc} restock (sku ${sku})`,
      subledger_type: "item",
      subledger_id: item.id,
    });
    lines.push({
      account_id: cogsId,
      debit: "0",
      credit: centsToDecimal(totalCostCents),
      memo: `${desc} cogs reversal (sku ${sku})`,
      subledger_type: "item",
      subledger_id: item.id,
    });
    layers.push({ item_id: item.id, qty, unit_cost_cents: unitCostCents });
  }

  return { lines, layers };
}

// ────────────────────────────────────────────────────────────────────────
// Local helpers (also exported for tests).
// ────────────────────────────────────────────────────────────────────────

export function centsToDecimal(cents) {
  const n = Math.trunc(Number(cents) || 0);
  const neg = n < 0;
  const abs = neg ? -n : n;
  const whole = Math.trunc(abs / 100);
  const frac = abs % 100;
  return `${neg ? "-" : ""}${whole}.${String(frac).padStart(2, "0")}`;
}

function toDateString(ts) {
  if (!ts) return new Date().toISOString().slice(0, 10);
  if (typeof ts === "string") return ts.slice(0, 10);
  if (ts instanceof Date) return ts.toISOString().slice(0, 10);
  return String(ts).slice(0, 10);
}
