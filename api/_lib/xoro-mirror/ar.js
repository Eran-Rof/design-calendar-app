// Cross-cutter T10-2 — AR mirror (per arch §4.1).
//
// Reads ip_sales_history_wholesale rows for a given mirror_date and reflects
// them into Tangerine's ar_invoices + ar_invoice_lines tables tagged with
// source='xoro_mirror'.
//
// Customer resolution: ip_sales_history_wholesale.customer_id → ip_customer_master.id
// → ip_customer_master.customer_code → customers.code (within entity).
//
// Idempotency: re-running for the same mirror_date is safe.
//   - For invoices already mirrored (source='xoro_mirror'): UPDATE the header
//     in place + DELETE existing 'xoro_mirror' lines + re-INSERT fresh.
//   - For invoices where a 'manual' row with the same number exists: SKIP +
//     count in rows_skipped_manual_conflict (per arch §1 rule 3).
//
// Unmatched customers are logged into the run's `errors` jsonb (we deliberately
// don't create an xoro_mirror_unmatched_customers table in this PR — schema
// migrations are gated to T10-1 only).
//
// Note on grain (per PPK rule): ip_sales_history_wholesale.qty_units is
// exploded eaches. For AR dollar totals we just sum unit_price * qty, which
// works in either grain because both are denominated in the same eaches.
// We don't need to recover native grain here.
//
// PUBLIC ENTRY: mirrorArForDate(supabase, entity_id, mirror_date).
//
// Returns:
//   {
//     rows_upserted: <number of ar_invoices upserted>,
//     rows_unchanged: <number unchanged because already up-to-date>,
//     rows_skipped_manual_conflict: <number skipped because manual row exists>,
//     errors: [ { kind, ...context } ],
//   }

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isISODate(v) {
  if (typeof v !== "string" || !ISO_DATE_RE.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().startsWith(v);
}

/**
 * Add `days` to an ISO YYYY-MM-DD date and return ISO YYYY-MM-DD.
 */
export function addDaysISO(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Compute the day boundaries for a mirror_date in ISO YYYY-MM-DD.
 * Returns inclusive start (the date itself) + exclusive end (next day).
 */
export function dayBounds(mirror_date) {
  return { start: mirror_date, end: addDaysISO(mirror_date, 1) };
}

/**
 * Convert a numeric amount (dollars) to integer cents using bankers-safe round.
 * Returns 0 for null/undefined.
 */
export function toCents(amount) {
  if (amount == null) return 0;
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/**
 * Compose one ar_invoice_lines row from an ip_sales_history_wholesale row.
 *
 * line_total_cents preference: net_amount → gross_amount → qty * unit_price.
 */
export function composeLine(invoice_id, line_number, src) {
  let line_total_cents = 0;
  if (src.net_amount != null) {
    line_total_cents = toCents(src.net_amount);
  } else if (src.gross_amount != null) {
    line_total_cents = toCents(src.gross_amount);
  } else if (src.unit_price != null && src.qty != null) {
    line_total_cents = Math.round(Number(src.unit_price) * Number(src.qty) * 100);
  }
  return {
    ar_invoice_id: invoice_id,
    line_number,
    description: src.description || src.order_number || null, // no `description` col; fall back to order_number
    inventory_item_id: src.sku_id || null,
    quantity: src.qty != null ? Number(src.qty) : null,
    unit_price_cents: src.unit_price != null ? toCents(src.unit_price) : null,
    line_total_cents,
    source: "xoro_mirror",
  };
}

/**
 * Group Xoro source rows by invoice_number. Rows missing invoice_number are
 * dropped (Xoro should always populate it for completed invoices).
 */
export function groupByInvoice(srcRows) {
  const groups = new Map();
  for (const r of srcRows || []) {
    if (!r || !r.invoice_number) continue;
    const key = r.invoice_number;
    if (!groups.has(key)) {
      groups.set(key, {
        invoice_number: r.invoice_number,
        invoice_date: r.invoice_date || r.txn_date || null,
        due_date: r.due_date || null,
        customer_id_src: r.customer_id || null,
        lines: [],
      });
    }
    groups.get(key).lines.push(r);
  }
  return groups;
}

/**
 * Build the invoice header row to upsert. total_amount_cents is summed
 * from composed line totals (lineCents array of integers).
 */
export function composeInvoiceHeader({
  entity_id,
  customer_id,
  group,
  total_amount_cents,
}) {
  const invoice_date = group.invoice_date;
  const due_date = group.due_date || (invoice_date ? addDaysISO(invoice_date, 30) : null);
  return {
    entity_id,
    customer_id,
    invoice_number: group.invoice_number,
    invoice_kind: "customer_invoice",
    gl_status: "unposted",
    invoice_date,
    // posting_date is NOT NULL on ar_invoices and was never set → every mirror
    // insert failed once the read was fixed. Date it to the Xoro txn date (=
    // invoice_date) per the Xoro-date policy so the shadow invoice lands in the
    // period it actually belongs to.
    posting_date: invoice_date,
    due_date,
    total_amount_cents,
    source: "xoro_mirror",
  };
}

/**
 * Resolve a Xoro customer-master id (FK on ip_sales_history_wholesale) → a
 * Tangerine customers.id. Returns null if the join can't complete.
 */
export async function resolveCustomerId(supabase, { entity_id, src_customer_id }) {
  if (!src_customer_id) return { customer_id: null, code: null, name: null };
  const { data: legacy } = await supabase
    .from("ip_customer_master")
    .select("id, customer_code, name")
    .eq("id", src_customer_id)
    .maybeSingle();
  if (!legacy || !legacy.customer_code) {
    return { customer_id: null, code: null, name: legacy?.name || null };
  }
  // Match on customer_code (the stable Xoro/external ref), NOT code: `code`
  // is the internal display code (being migrated to CUST-NNNNN), while
  // customer_code permanently holds the legacy EXCEL:/ATS: import key. Every
  // customer has a customer_code; this match is value-identical to the old
  // code-match today and survives the code -> CUST-NNNNN backfill.
  const { data: matched } = await supabase
    .from("customers")
    .select("id")
    .eq("entity_id", entity_id)
    .eq("customer_code", legacy.customer_code)
    // Never resolve to a merged-away / soft-deleted duplicate. When an ALL-CAPS
    // mirror duplicate has been merged into its proper-cased sibling (and
    // tombstoned), a future mirror run must NOT re-attach invoices to the
    // tombstone — it logs the customer as unmatched instead, leaving the already
    // merged AR under the keeper.
    .is("deleted_at", null)
    .maybeSingle();
  return {
    customer_id: matched?.id || null,
    code: legacy.customer_code,
    name: legacy.name || null,
  };
}

/**
 * Main entry point.
 *
 * @param {object} supabase     Supabase service-role client (chainable).
 * @param {string} entity_id    Tangerine entity uuid.
 * @param {string} mirror_date  Operator-local business date 'YYYY-MM-DD'.
 * @returns {Promise<{rows_upserted:number, rows_unchanged:number, rows_skipped_manual_conflict:number, errors:Array<object>}>}
 */
export async function mirrorArForDate(supabase, entity_id, mirror_date) {
  const summary = {
    rows_upserted: 0,
    rows_unchanged: 0,
    rows_skipped_manual_conflict: 0,
    errors: [],
  };

  if (!entity_id) {
    summary.errors.push({ kind: "bad_entity", message: "entity_id is required" });
    return summary;
  }
  if (!isISODate(mirror_date)) {
    summary.errors.push({ kind: "bad_date", message: `mirror_date '${mirror_date}' is not YYYY-MM-DD` });
    return summary;
  }

  const { start, end } = dayBounds(mirror_date);

  // ip_sales_history_wholesale.invoice_date doesn't exist on this table — the
  // canonical date column is `txn_date`. We filter on txn_date but also fall
  // back to invoice_date in composeInvoiceHeader so future shape changes are
  // forgiving. (We try both filters to handle drift — see arch §9 risk #1.)
  let srcRows = [];
  try {
    const { data, error } = await supabase
      .from("ip_sales_history_wholesale")
      // NOTE: this table has NO `description` column (real columns: order_number,
      // invoice_number, txn_type, net_amount, …). Selecting it made EVERY AR read
      // fail ('column ... description does not exist') → 0 invoices mirrored.
      // Select order_number instead and use it as the line descriptor.
      .select("id, sku_id, customer_id, invoice_number, order_number, txn_date, qty, qty_units, unit_price, gross_amount, discount_amount, net_amount")
      .gte("txn_date", start)
      .lt("txn_date", end);
    if (error) {
      summary.errors.push({ kind: "source_read_failed", message: error.message });
      return summary;
    }
    srcRows = data || [];
  } catch (e) {
    summary.errors.push({ kind: "source_read_threw", message: e instanceof Error ? e.message : String(e) });
    return summary;
  }

  if (srcRows.length === 0) {
    return summary;
  }

  // Decorate each src row with invoice_date so composeInvoiceHeader sees it
  // even though the column is called txn_date upstream.
  for (const r of srcRows) {
    if (!r.invoice_date) r.invoice_date = r.txn_date;
  }

  const groups = groupByInvoice(srcRows);

  for (const group of groups.values()) {
    try {
      await processGroup(supabase, { entity_id, group, summary });
    } catch (e) {
      summary.errors.push({
        kind: "group_failed",
        invoice_number: group.invoice_number,
        message: e instanceof Error ? e.message : String(e),
      });
      // continue with next invoice
    }
  }

  return summary;
}

/**
 * Process one Xoro invoice group: resolve customer → upsert ar_invoices →
 * delete-and-reinsert ar_invoice_lines.
 */
async function processGroup(supabase, { entity_id, group, summary }) {
  // 1. Resolve customer.
  const resolved = await resolveCustomerId(supabase, {
    entity_id,
    src_customer_id: group.customer_id_src,
  });
  if (!resolved.customer_id) {
    summary.errors.push({
      kind: "unmatched_customer",
      invoice_number: group.invoice_number,
      source_customer_id: group.customer_id_src,
      source_customer_code: resolved.code,
      source_customer_name: resolved.name,
    });
    // eslint-disable-next-line no-console
    console.warn(
      `[xoro-mirror.ar] unmatched customer for invoice ${group.invoice_number}` +
      ` (src_customer_id=${group.customer_id_src} code=${resolved.code || "<none>"})`,
    );
    return;
  }

  // 2. Compose lines first so we know the total.
  const composedLines = group.lines.map((src, i) => composeLine(null, i + 1, src));
  const total_amount_cents = composedLines.reduce((sum, l) => sum + (l.line_total_cents || 0), 0);

  // 3. Look up the existing invoice (if any) by (entity_id, invoice_number)
  //    to decide between INSERT, UPDATE, or skip-manual-conflict.
  const { data: existing, error: lookupErr } = await supabase
    .from("ar_invoices")
    .select("id, source, total_amount_cents, invoice_date, due_date, customer_id")
    .eq("entity_id", entity_id)
    .eq("invoice_number", group.invoice_number)
    .maybeSingle();
  if (lookupErr) {
    summary.errors.push({
      kind: "lookup_failed",
      invoice_number: group.invoice_number,
      message: lookupErr.message,
    });
    return;
  }

  const header = composeInvoiceHeader({
    entity_id,
    customer_id: resolved.customer_id,
    group,
    total_amount_cents,
  });

  let invoiceId;
  let headerWasUnchanged = false;
  if (!existing) {
    // INSERT new mirror row.
    const { data: inserted, error: insErr } = await supabase
      .from("ar_invoices")
      .insert(header)
      .select("id")
      .maybeSingle();
    if (insErr || !inserted) {
      summary.errors.push({
        kind: "insert_failed",
        invoice_number: group.invoice_number,
        message: insErr?.message || "insert returned no row",
      });
      return;
    }
    invoiceId = inserted.id;
  } else if (existing.source !== "xoro_mirror") {
    // Operator-typed row wins (arch §1 rule 3).
    summary.rows_skipped_manual_conflict += 1;
    summary.errors.push({
      kind: "manual_conflict",
      invoice_number: group.invoice_number,
      existing_source: existing.source,
    });
    return;
  } else {
    // UPDATE existing mirror row.
    invoiceId = existing.id;
    const sameTotal = Number(existing.total_amount_cents) === Number(total_amount_cents);
    const sameDate = String(existing.invoice_date || "") === String(header.invoice_date || "");
    const sameCustomer = String(existing.customer_id || "") === String(header.customer_id || "");
    headerWasUnchanged = sameTotal && sameDate && sameCustomer;
    if (!headerWasUnchanged) {
      const { error: updErr } = await supabase
        .from("ar_invoices")
        .update({
          customer_id: header.customer_id,
          invoice_date: header.invoice_date,
          posting_date: header.posting_date,
          due_date: header.due_date,
          total_amount_cents: header.total_amount_cents,
        })
        .eq("id", invoiceId);
      if (updErr) {
        summary.errors.push({
          kind: "update_failed",
          invoice_number: group.invoice_number,
          message: updErr.message,
        });
        return;
      }
    }
  }

  // 4. Wipe existing xoro_mirror lines + re-insert.
  const { error: delErr } = await supabase
    .from("ar_invoice_lines")
    .delete()
    .eq("ar_invoice_id", invoiceId)
    .eq("source", "xoro_mirror");
  if (delErr) {
    summary.errors.push({
      kind: "lines_delete_failed",
      invoice_number: group.invoice_number,
      message: delErr.message,
    });
    return;
  }

  // Stamp ar_invoice_id on the composed lines.
  const linesToInsert = composedLines.map((l) => ({ ...l, ar_invoice_id: invoiceId }));
  if (linesToInsert.length > 0) {
    const { error: linesErr } = await supabase
      .from("ar_invoice_lines")
      .insert(linesToInsert);
    if (linesErr) {
      summary.errors.push({
        kind: "lines_insert_failed",
        invoice_number: group.invoice_number,
        message: linesErr.message,
      });
      return;
    }
  }

  // Counter bookkeeping. We always get here on a successful mirror.
  if (headerWasUnchanged) {
    summary.rows_unchanged += 1;
  } else {
    summary.rows_upserted += 1;
  }
}

export default mirrorArForDate;
