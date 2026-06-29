// api/_lib/inventory/partFifo.js
//
// Manufacturing module — JavaScript wrapper around the part FIFO engine
// (part_inventory_layers + part_inventory_consumption + part_fifo_consume RPC).
// Parallels api/_lib/inventory/fifo.js but bound to part_master parts, which are
// kept entirely separate from finished-style inventory.
//
//   createPartLayer(supabase, { ... }) — INSERT one part_inventory_layers row.
//   consumePart(supabase, { ... })     — RPC wrapper → { cogs_cents: bigint }.
//
// Like fifo.js, this does NOT post to GL. The caller's posting rule authors the
// journal entry from the returned cogs_cents.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_SOURCE_KIND = new Set([
  "ap_invoice",
  "adjustment",
  "opening_balance",
  "transfer_in",
  "po_receipt",
]);

const VALID_CONSUMER_KIND = new Set([
  "build_issue",
  "adjustment_decrease",
  "transfer_out",
  "write_off",
]);

export class PartInventoryError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function assertUuid(name, val, opts = {}) {
  if (val == null || val === "") {
    if (opts.optional) return;
    throw new PartInventoryError("missing_field", `${name} is required`);
  }
  if (typeof val !== "string" || !UUID_RE.test(val)) {
    throw new PartInventoryError("invalid_uuid", `${name} must be a uuid (got ${typeof val})`);
  }
}

function assertPositiveNumber(name, val) {
  if (val == null) throw new PartInventoryError("missing_field", `${name} is required`);
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) {
    throw new PartInventoryError("invalid_qty", `${name} must be > 0 (got ${val})`);
  }
}

function assertNonNegativeInt(name, val) {
  if (val == null) throw new PartInventoryError("missing_field", `${name} is required`);
  const n = typeof val === "bigint" ? val : Number(val);
  if (typeof n === "number" && (!Number.isFinite(n) || n < 0)) {
    throw new PartInventoryError("invalid_cents", `${name} must be >= 0 integer cents (got ${val})`);
  }
  if (typeof n === "bigint" && n < 0n) {
    throw new PartInventoryError("invalid_cents", `${name} must be >= 0 integer cents (got ${val})`);
  }
}

/**
 * Insert one part_inventory_layers row.
 * @returns {Promise<{layer: Object}>}
 */
export async function createPartLayer(supabase, args) {
  if (!supabase) throw new PartInventoryError("missing_client", "supabase client required");
  if (!args || typeof args !== "object") {
    throw new PartInventoryError("invalid_args", "args must be an object");
  }
  assertUuid("entity_id", args.entity_id);
  assertUuid("part_id", args.part_id);
  assertPositiveNumber("qty", args.qty);
  assertNonNegativeInt("unit_cost_cents", args.unit_cost_cents);
  if (!VALID_SOURCE_KIND.has(args.source_kind)) {
    throw new PartInventoryError(
      "invalid_source_kind",
      `source_kind must be one of ${[...VALID_SOURCE_KIND].join("|")} (got ${args.source_kind})`,
    );
  }
  assertUuid("source_invoice_id", args.source_invoice_id, { optional: true });
  assertUuid("source_adjustment_id", args.source_adjustment_id, { optional: true });
  assertUuid("location_id", args.location_id, { optional: true });
  assertUuid("created_by_user_id", args.created_by_user_id, { optional: true });

  const row = {
    entity_id: args.entity_id,
    part_id: args.part_id,
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
    notes: args.notes || null,
    created_by_user_id: args.created_by_user_id || null,
  };
  if (args.location_id) row.location_id = args.location_id;

  const { data, error } = await supabase
    .from("part_inventory_layers")
    .insert(row)
    .select()
    .single();

  if (error) throw new PartInventoryError("layer_insert_failed", error.message, error);
  return { layer: data };
}

/**
 * Atomically consume `qty` from the FIFO part layers for (entity_id, part_id).
 * @returns {Promise<{cogs_cents: bigint}>}
 */
export async function consumePart(supabase, args) {
  if (!supabase) throw new PartInventoryError("missing_client", "supabase client required");
  if (!args || typeof args !== "object") {
    throw new PartInventoryError("invalid_args", "args must be an object");
  }
  assertUuid("entity_id", args.entity_id);
  assertUuid("part_id", args.part_id);
  assertPositiveNumber("qty", args.qty);
  if (!VALID_CONSUMER_KIND.has(args.consumer_kind)) {
    throw new PartInventoryError(
      "invalid_consumer_kind",
      `consumer_kind must be one of ${[...VALID_CONSUMER_KIND].join("|")} (got ${args.consumer_kind})`,
    );
  }
  assertUuid("consumer_ref_id", args.consumer_ref_id, { optional: true });
  assertUuid("location_id", args.location_id, { optional: true });
  assertUuid("user_id", args.user_id, { optional: true });

  const { data, error } = await supabase.rpc("part_fifo_consume", {
    p_entity_id: args.entity_id,
    p_part_id: args.part_id,
    p_qty: args.qty,
    p_consumer_kind: args.consumer_kind,
    p_consumer_ref_id: args.consumer_ref_id || null,
    p_user_id: args.user_id || null,
    p_location_id: args.location_id || null,
  });

  if (error) {
    const code = /insufficient part inventory/i.test(error.message || "")
      ? "insufficient_inventory"
      : "consume_failed";
    throw new PartInventoryError(code, error.message || "Part FIFO consume failed", error);
  }

  let cogs_cents;
  if (data == null) cogs_cents = 0n;
  else if (typeof data === "bigint") cogs_cents = data;
  else if (typeof data === "number") cogs_cents = BigInt(Math.trunc(data));
  else cogs_cents = BigInt(data);

  return { cogs_cents };
}

export const partFifoAPI = { createPartLayer, consumePart, PartInventoryError };
