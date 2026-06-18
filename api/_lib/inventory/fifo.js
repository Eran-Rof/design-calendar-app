// api/_lib/inventory/fifo.js
//
// Tangerine M5 Inventory FIFO — JavaScript wrapper around the PL/pgSQL RPC
// `inventory_fifo_consume` and the inventory_layers table.
//
//   inventoryFifoAPI.createLayer(supabase, { ... })  — INSERT one
//      inventory_layers row. Called at AP invoice posting for inventory lines
//      (P3-4), at positive M37 adjustments (P3-5), and at opening-balance
//      seed bootstrap.
//
//   inventoryFifoAPI.consume(supabase, { ... })  — RPC wrapper. Returns
//      { cogs_cents: bigint } on success. Re-wraps PG errors into a clean
//      InventoryError so callers can pattern-match on .code.
//
// Loose coupling: this module does NOT post to GL. The caller (AR posting in
// P4, M37 in P3-5) takes the returned cogs_cents and adds it to its own
// journal entry. Layers and consumption are an audit ledger; the GL impact is
// authored by the caller's posting rule.
//
// Per docs/tangerine/P3-acc-core-architecture.md §4.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_SOURCE_KIND = new Set([
  "ap_invoice",
  "adjustment",
  "opening_balance",
  "transfer_in",
  "credit_memo_return",   // P4-2 — AR credit memo with return-to-stock line
  "po_receipt",           // P13/C1 — PO goods-receipt layer at landed unit cost
  "manufacture",          // M4 — finished goods off a manufacturing build (WIP→FG)
]);

const VALID_CONSUMER_KIND = new Set([
  "ar_invoice",
  "adjustment_decrease",
  "transfer_out",
  "write_off",
]);

export class InventoryError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function assertUuid(name, val, opts = {}) {
  if (val == null || val === "") {
    if (opts.optional) return;
    throw new InventoryError("missing_field", `${name} is required`);
  }
  if (typeof val !== "string" || !UUID_RE.test(val)) {
    throw new InventoryError("invalid_uuid", `${name} must be a uuid (got ${typeof val})`);
  }
}

function assertPositiveNumber(name, val) {
  if (val == null) {
    throw new InventoryError("missing_field", `${name} is required`);
  }
  if (typeof val !== "number" && typeof val !== "string") {
    throw new InventoryError("invalid_number", `${name} must be a number (got ${typeof val})`);
  }
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) {
    throw new InventoryError("invalid_qty", `${name} must be > 0 (got ${val})`);
  }
}

function assertNonNegativeInt(name, val) {
  if (val == null) {
    throw new InventoryError("missing_field", `${name} is required`);
  }
  // Allow JS number, string, or BigInt — RPC payload is text-encoded.
  const n = typeof val === "bigint" ? val : Number(val);
  if (typeof n === "number" && (!Number.isFinite(n) || n < 0)) {
    throw new InventoryError("invalid_cents", `${name} must be >= 0 integer cents (got ${val})`);
  }
  if (typeof n === "bigint" && n < 0n) {
    throw new InventoryError("invalid_cents", `${name} must be >= 0 integer cents (got ${val})`);
  }
}

/**
 * Insert one inventory_layers row.
 *
 * Called at:
 *   - AP invoice posting (P3-4) for each line with inventory_item_id — source_kind='ap_invoice'
 *   - Positive M37 adjustment (P3-5)                                 — source_kind='adjustment'
 *   - Transfer-in (P3-7)                                             — source_kind='transfer_in'
 *
 * @param {Object} supabase  Service-role client
 * @param {Object} args
 * @param {string} args.entity_id
 * @param {string} args.item_id              FK ip_item_master(id)
 * @param {number|string} args.qty           original + remaining (numeric)
 * @param {number|bigint|string} args.unit_cost_cents
 * @param {string} args.source_kind          ap_invoice|adjustment|opening_balance|transfer_in
 * @param {string} [args.source_invoice_id]  FK invoices when source_kind=ap_invoice
 * @param {string} [args.source_adjustment_id] FK inventory_adjustments (post-P3-5)
 * @param {string} [args.received_at]        ISO timestamp; defaults to now()
 * @param {string} [args.lot_number]         lot the stock belongs to (free text)
 * @param {string} [args.notes]
 * @param {string} [args.created_by_user_id]
 * @returns {Promise<{layer: Object}>}
 */
export async function createLayer(supabase, args) {
  if (!supabase) throw new InventoryError("missing_client", "supabase client required");
  if (!args || typeof args !== "object") {
    throw new InventoryError("invalid_args", "args must be an object");
  }
  assertUuid("entity_id", args.entity_id);
  assertUuid("item_id", args.item_id);
  assertPositiveNumber("qty", args.qty);
  assertNonNegativeInt("unit_cost_cents", args.unit_cost_cents);
  if (!VALID_SOURCE_KIND.has(args.source_kind)) {
    throw new InventoryError(
      "invalid_source_kind",
      `source_kind must be one of ${[...VALID_SOURCE_KIND].join("|")} (got ${args.source_kind})`,
    );
  }
  assertUuid("source_invoice_id", args.source_invoice_id, { optional: true });
  assertUuid("source_adjustment_id", args.source_adjustment_id, { optional: true });
  assertUuid("created_by_user_id", args.created_by_user_id, { optional: true });
  assertUuid("partition_id", args.partition_id, { optional: true }); // P15 brand stock pool
  assertUuid("location_id", args.location_id, { optional: true });   // P12-0 multi-location

  const row = {
    entity_id: args.entity_id,
    item_id: args.item_id,
    received_at: args.received_at || new Date().toISOString(),
    original_qty: args.qty,
    remaining_qty: args.qty,
    unit_cost_cents:
      typeof args.unit_cost_cents === "bigint"
        ? args.unit_cost_cents.toString()
        : args.unit_cost_cents,
    source_kind: args.source_kind,
    source_invoice_id: args.source_invoice_id || null,
    source_adjustment_id: args.source_adjustment_id || null,
    partition_id: args.partition_id || null,
    // Lot the stock belongs to (from the originating PO line at receipt). Enables
    // lot-aware available-to-sell allocation. Optional, free text.
    lot_number:
      args.lot_number != null && String(args.lot_number).trim() !== ""
        ? String(args.lot_number).trim()
        : null,
    notes: args.notes || null,
    created_by_user_id: args.created_by_user_id || null,
  };
  // location_id is NOT NULL on inventory_layers (P12-0 multi-location). Only set
  // it when provided — callers that stock to a specific location pass it.
  if (args.location_id) row.location_id = args.location_id;

  const { data, error } = await supabase
    .from("inventory_layers")
    .insert(row)
    .select()
    .single();

  if (error) {
    throw new InventoryError("layer_insert_failed", error.message, error);
  }
  return { layer: data };
}

/**
 * Atomically consume `qty` from the FIFO layers for (entity_id, item_id).
 *
 * Calls the PL/pgSQL function inventory_fifo_consume(...) inside its own
 * transaction. The function locks open layers FOR UPDATE in (received_at ASC,
 * id ASC) order, draws each down until qty is satisfied, inserts an
 * inventory_consumption row per draw, and returns the total cogs_cents.
 *
 * Insufficient-inventory at the SQL layer surfaces as an error from
 * supabase.rpc — we re-throw as InventoryError('consume_failed').
 *
 * P4-3 contract notes:
 *   - `consumer_kind='ar_invoice'` is the AR send-time path. The consumer_ref_id
 *     points at ar_invoice_lines.id (NOT the parent ar_invoice — per-line so a
 *     credit-memo can reverse a single line). The SQL CHECK constraint on
 *     inventory_consumption.consumer_kind already accepts 'ar_invoice' (P3-3
 *     fifo schema migration).
 *
 * TODO P4-8 (historical backfill):
 *   The 5-year backfill needs to consume against pre-AR-cutover layers only —
 *   later forward layers must NOT backfill historical sales. Add an optional
 *   `p_layer_cutoff_date` parameter to the RPC so callers can scope the FIFO
 *   sweep to layers with `received_at <= cutoff`. The JS wrapper will expose
 *   it as `args.layer_cutoff_date`. The arch (§6.4) currently has the backfill
 *   BYPASS FIFO entirely and use the recorded `unit_cost_at_sale` directly;
 *   this TODO is the fallback path if a future operator wants per-layer
 *   accuracy on historical sales.
 *
 * @param {Object} supabase
 * @param {Object} args
 * @param {string} args.entity_id
 * @param {string} args.item_id
 * @param {number|string} args.qty            Must be > 0
 * @param {string} args.consumer_kind         ar_invoice|adjustment_decrease|transfer_out|write_off
 * @param {string} [args.consumer_ref_id]     FK ar_invoice_lines(id) for ar_invoice; FK
 *                                            inventory_adjustments(id) for the others
 * @param {string} [args.user_id]
 * @returns {Promise<{cogs_cents: bigint}>}
 */
export async function consume(supabase, args) {
  if (!supabase) throw new InventoryError("missing_client", "supabase client required");
  if (!args || typeof args !== "object") {
    throw new InventoryError("invalid_args", "args must be an object");
  }
  assertUuid("entity_id", args.entity_id);
  assertUuid("item_id", args.item_id);
  assertPositiveNumber("qty", args.qty);
  if (!VALID_CONSUMER_KIND.has(args.consumer_kind)) {
    throw new InventoryError(
      "invalid_consumer_kind",
      `consumer_kind must be one of ${[...VALID_CONSUMER_KIND].join("|")} (got ${args.consumer_kind})`,
    );
  }
  assertUuid("consumer_ref_id", args.consumer_ref_id, { optional: true });
  assertUuid("user_id", args.user_id, { optional: true });
  assertUuid("partition_id", args.partition_id, { optional: true }); // P15 — draw from this brand pool

  const { data, error } = await supabase.rpc("inventory_fifo_consume", {
    p_entity_id: args.entity_id,
    p_item_id: args.item_id,
    p_qty: args.qty,
    p_consumer_kind: args.consumer_kind,
    p_consumer_ref_id: args.consumer_ref_id || null,
    p_user_id: args.user_id || null,
    p_partition_id: args.partition_id || null,
  });

  if (error) {
    // The PL/pgSQL RAISE EXCEPTION for insufficient inventory bubbles up here.
    // Surface it with a stable code so handlers can show a clean message.
    const code = /insufficient inventory/i.test(error.message || "")
      ? "insufficient_inventory"
      : "consume_failed";
    throw new InventoryError(code, error.message || "FIFO consume failed", error);
  }

  // data is the bigint return — Supabase serializes as string for safety on
  // very large values. Coerce to BigInt for callers; Number is also acceptable
  // here since cogs_cents fits easily in JS-safe-int range for any single sale.
  let cogs_cents;
  if (data == null) {
    cogs_cents = 0n;
  } else if (typeof data === "bigint") {
    cogs_cents = data;
  } else if (typeof data === "number") {
    cogs_cents = BigInt(Math.trunc(data));
  } else {
    // string (most likely)
    cogs_cents = BigInt(data);
  }

  return { cogs_cents };
}

export const inventoryFifoAPI = {
  createLayer,
  consume,
  InventoryError,
};
