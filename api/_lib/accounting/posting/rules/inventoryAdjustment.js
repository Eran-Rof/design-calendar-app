// api/_lib/accounting/posting/rules/inventoryAdjustment.js
//
// Tangerine M37 inventory adjustment posting rule (P3-5 — arch §5.2/§5.3).
//
// One event.kind = 'inventory_adjustment' covers all six adjustment_types
// (damage / shrinkage / found / correction / write_off / return_to_vendor).
// The DR/CR direction is driven by the sign of qty_delta — not by the type
// string. The type string is operator metadata that flows through the memo.
//
// Both bases post the same JE: an inventory adjustment is a non-cash event
// that affects the inventory asset identically on accrual and cash books.
//
// ────────────────────────────────────────────────────────────────────────────
// POSITIVE qty_delta  (new inventory appears — 'found' / 'correction-up' /
//                     'return-from-customer-reclassified-as-found')
// ────────────────────────────────────────────────────────────────────────────
//   Amount = qty_delta × unit_cost_cents
//   DR inventory_account_id (subledger=item)
//   CR gl_account_id        (typically inventory-found income or
//                            contra-shrinkage)
//   Side-effect: ONE inventory_layers row is queued on
//     ruleOutput.inventoryLayers[] (same drain path P3-4 introduced for
//     apInvoiceReceived). source_kind='adjustment', source_adjustment_id set.
//
// ────────────────────────────────────────────────────────────────────────────
// NEGATIVE qty_delta  (inventory removed — 'damage' / 'shrinkage' / 'write_off'
//                     / 'return_to_vendor' / 'correction-down')
// ────────────────────────────────────────────────────────────────────────────
//   The rule alone cannot determine the cents amount: FIFO will draw across
//   any number of layers each at its own historical cost. So the rule emits
//   a `consumePlan` describing what to consume, and the posting service
//   (api/_lib/accounting/posting/index.js) calls inventory_fifo_consume()
//   BEFORE persisting, captures cogs_cents, then mutates the rule output's
//   accrual + cash candidate amounts to match the FIFO-derived value.
//
//   Amount = cogs_cents (derived from FIFO consume)
//   DR gl_account_id       (typically shrinkage / damage / write-off expense)
//   CR inventory_account_id (subledger=item)
//
//   The rule fills the JE lines with a sentinel amount of "0" and the
//   posting service rewrites them after consume(). This keeps the contract
//   that the rule is a pure data producer; the side-effecting call lives
//   in postEvent.
//
// ────────────────────────────────────────────────────────────────────────────
// Inventory GL account resolution
// ────────────────────────────────────────────────────────────────────────────
// The handler resolves the entity's default inventory asset account before
// invoking postEvent and passes it as event.data.inventory_account_id. If the
// handler can't find a clean default, it errors out before the rule fires;
// the rule itself just trusts the field. See the handler's resolveInventoryAccount()
// for the lookup heuristic (code='1300' → name ilike 'inventory%' → fail).

/**
 * @param {import('../types.js').PostingEvent} event
 *   event.data = {
 *     adjustment_id: string,           // uuid of the inventory_adjustments row
 *     item_id: string,                 // uuid into ip_item_master
 *     adjustment_type: string,         // damage|shrinkage|found|correction|write_off|return_to_vendor
 *     qty_delta: number|string,        // SIGNED. Positive => layer creation; Negative => FIFO consume.
 *     unit_cost_cents: number|string|bigint, // REQUIRED when qty_delta > 0. Ignored when qty_delta < 0.
 *     inventory_account_id: string,    // FK gl_accounts(id) — the inventory asset account
 *     gl_account_id: string,           // FK gl_accounts(id) — the counter (expense/revenue/contra) account
 *     posting_date: 'YYYY-MM-DD',
 *     reason?: string,                 // operator notes — flows into JE memo
 *   }
 * @returns {import('../types.js').PostingRuleOutput}
 *   Positive path: { accrual, cash, inventoryLayers: [...] }
 *   Negative path: { accrual, cash, consumePlan: [...] }
 *
 *   The accrual + cash candidates share the same lines (USD non-cash event).
 *   The negative-path candidates carry sentinel "0" debits/credits that the
 *   posting service rewrites once FIFO consume has produced the true amount.
 */
export function inventoryAdjustment(event) {
  const d = event.data;
  required(d, [
    "adjustment_id", "item_id", "adjustment_type", "qty_delta",
    "inventory_account_id", "gl_account_id", "posting_date",
  ]);

  // qty_delta validation. We accept number or numeric string.
  const qtyDelta = toNumeric(d.qty_delta, "qty_delta");
  if (qtyDelta === 0) {
    throw new Error("inventoryAdjustment: qty_delta cannot be zero");
  }

  const validTypes = ["damage", "shrinkage", "found", "correction", "write_off", "return_to_vendor"];
  if (!validTypes.includes(d.adjustment_type)) {
    throw new Error(
      `inventoryAdjustment: adjustment_type must be one of ${validTypes.join("|")} (got '${d.adjustment_type}')`,
    );
  }

  const isUp = qtyDelta > 0;

  const descBase = `Inventory adjustment ${d.adjustment_id} (${d.adjustment_type}, ${isUp ? "+" : ""}${qtyDelta})`;
  const desc = d.reason ? `${descBase}: ${d.reason}` : descBase;

  if (isUp) {
    // Positive — unit_cost_cents is required so we can author the JE up-front.
    if (d.unit_cost_cents == null || d.unit_cost_cents === "") {
      throw new Error("inventoryAdjustment: unit_cost_cents required for positive qty_delta");
    }
    const unitCostCents = toBigIntCents(d.unit_cost_cents, "unit_cost_cents");
    if (unitCostCents < 0n) {
      throw new Error("inventoryAdjustment: unit_cost_cents must be >= 0");
    }
    const totalCents = BigInt(Math.trunc(Math.abs(qtyDelta) * 10000)) * unitCostCents / 10000n;
    const amountStr = fromCents(totalCents);

    const lines = [
      {
        line_number: 1,
        account_id: d.inventory_account_id,
        debit: amountStr,
        credit: "0",
        memo: desc,
        subledger_type: "item",
        subledger_id: d.item_id,
      },
      {
        line_number: 2,
        account_id: d.gl_account_id,
        debit: "0",
        credit: amountStr,
        memo: desc,
        subledger_type: null,
        subledger_id: null,
      },
    ];

    const base = {
      entity_id: event.entity_id,
      journal_type: "adjustment",
      posting_date: d.posting_date,
      source_module: "inventory",
      source_table: "inventory_adjustments",
      source_id: d.adjustment_id,
      description: desc,
      created_by_user_id: event.created_by_user_id ?? null,
      lines,
    };

    return {
      accrual: { ...base, basis: "ACCRUAL", lines: cloneLines(lines) },
      cash:    { ...base, basis: "CASH",    lines: cloneLines(lines) },
      inventoryLayers: [
        {
          item_id: d.item_id,
          qty: Math.abs(qtyDelta),
          unit_cost_cents: d.unit_cost_cents,
          source_kind: "adjustment",
          source_adjustment_id: d.adjustment_id,
          received_at: d.posting_date,
          notes: d.reason || null,
        },
      ],
    };
  }

  // Negative — emit consumePlan + sentinel-amount JE candidates. The posting
  // service drains consumePlan, calls inventory_fifo_consume(), and rewrites
  // the line debit/credit amounts to the returned cogs_cents BEFORE persist.
  const qtyAbs = Math.abs(qtyDelta);
  const sentinel = "0";

  const lines = [
    {
      line_number: 1,
      account_id: d.gl_account_id,
      debit: sentinel, // rewritten by postEvent after consume()
      credit: "0",
      memo: desc,
      subledger_type: null,
      subledger_id: null,
    },
    {
      line_number: 2,
      account_id: d.inventory_account_id,
      debit: "0",
      credit: sentinel, // rewritten by postEvent after consume()
      memo: desc,
      subledger_type: "item",
      subledger_id: d.item_id,
    },
  ];

  const base = {
    entity_id: event.entity_id,
    journal_type: "adjustment",
    posting_date: d.posting_date,
    source_module: "inventory",
    source_table: "inventory_adjustments",
    source_id: d.adjustment_id,
    description: desc,
    created_by_user_id: event.created_by_user_id ?? null,
    lines,
  };

  return {
    accrual: { ...base, basis: "ACCRUAL", lines: cloneLines(lines) },
    cash:    { ...base, basis: "CASH",    lines: cloneLines(lines) },
    consumePlan: [
      {
        item_id: d.item_id,
        qty: qtyAbs,
        consumer_kind: "adjustment_decrease",
        consumer_ref_id: d.adjustment_id,
      },
    ],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────────────

function required(obj, fields) {
  for (const f of fields) {
    if (obj?.[f] == null || obj[f] === "") {
      throw new Error(`inventoryAdjustment: data.${f} is required`);
    }
  }
}

function toNumeric(v, name) {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`inventoryAdjustment: ${name} must be finite (got ${v})`);
    return v;
  }
  if (typeof v === "string") {
    if (!/^-?\d+(\.\d+)?$/.test(v)) {
      throw new Error(`inventoryAdjustment: ${name} must be a numeric string (got ${v})`);
    }
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`inventoryAdjustment: ${name} parse failed`);
    return n;
  }
  if (typeof v === "bigint") return Number(v);
  throw new Error(`inventoryAdjustment: ${name} must be number|string|bigint (got ${typeof v})`);
}

function toBigIntCents(v, name) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || !Number.isInteger(v)) {
      throw new Error(`inventoryAdjustment: ${name} must be an integer cents value (got ${v})`);
    }
    return BigInt(v);
  }
  if (typeof v === "string") {
    if (!/^-?\d+$/.test(v)) {
      throw new Error(`inventoryAdjustment: ${name} must be an integer cents string (got ${v})`);
    }
    return BigInt(v);
  }
  throw new Error(`inventoryAdjustment: ${name} must be number|string|bigint (got ${typeof v})`);
}

// cents (bigint) → decimal-string ("123.45"). Mirrors apInvoiceReceived helper.
function fromCents(cents) {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const whole = abs / 100n;
  const frac = abs % 100n;
  const fracStr = frac.toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole.toString()}.${fracStr}`;
}

// The accrual + cash twins each get a fresh copy so the posting service can
// rewrite amounts in-place without aliasing.
function cloneLines(lines) {
  return lines.map((l) => ({ ...l }));
}
