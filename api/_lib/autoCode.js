// api/_lib/autoCode.js
//
// Chunk M — auto-generated, read-only codes (operator item 14).
//
// Server-side generator for the `code` field of the six auto-coded masters
// (Customers, Vendors, Employees, Fabric, Factor/Insurance, Payment Terms).
// Mirrors the count+1 scheme used by nextInvoiceNumber in
// api/_handlers/internal/ar-invoices/index.js: count existing rows carrying
// the prefix, +1, zero-pad to 5 digits (e.g. CUST-00001). A (entity_id, code)
// unique index catches the rare concurrent collision; insertWithAutoCode wraps
// the insert in a small retry that bumps the sequence on a Postgres 23505.
//
// These codes are auto-suggested only — NOT a strict monotonic sequence. For
// admin-entry volumes (a handful of new rows at a time) this is concurrency-safe
// enough; the retry guarantees uniqueness even under the occasional race.

/**
 * Compute the next code string for a prefix by counting existing rows that
 * already carry that prefix and adding 1 (then zero-padding to `pad` digits).
 *
 * @param {object}   admin      supabase service-role client
 * @param {string}   table      table name (e.g. "customers")
 * @param {string}   column     code column name (e.g. "code")
 * @param {string}   prefix     code prefix incl. trailing dash (e.g. "CUST-")
 * @param {object}   [opts]
 * @param {string}   [opts.entityId]  when set, scope the count to this entity_id
 * @param {number}   [opts.pad=5]     zero-pad width for the numeric suffix
 * @param {number}   [opts.bump=0]    additional offset added to the next number
 *                                    (used by the retry to skip a taken code)
 * @returns {Promise<string>} e.g. "CUST-00001"
 */
export async function nextCode(admin, table, column, prefix, opts = {}) {
  const { entityId = null, pad = 5, bump = 0 } = opts;
  // Use MAX(numeric suffix)+1, NOT COUNT+1. A count-based next number collides
  // with existing codes whenever the sequence has gaps (deleted/imported rows),
  // e.g. 192 CUST- rows numbered up to CUST-00195 → count+1=CUST-00193 already
  // exists → unique violation, and the small retry can't climb past the dense
  // region (→ spurious 409 "could not allocate a unique code"). Fetching the
  // existing codes and taking the real max is gap-proof. Volumes here are in the
  // hundreds per master, well under the PostgREST row cap.
  let q = admin
    .from(table)
    .select(column)
    .ilike(column, `${prefix}%`);
  if (entityId) q = q.eq("entity_id", entityId);
  const { data } = await q;
  let max = 0;
  for (const row of data || []) {
    const m = String(row[column] ?? "").match(/(\d+)\s*$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  const next = max + 1 + bump;
  return `${prefix}${String(next).padStart(pad, "0")}`;
}

/**
 * Insert a row whose `code` (or other) column is server-generated, retrying on
 * a unique-constraint collision by bumping the sequence number.
 *
 * `buildRow(code)` must return the full insert object with the generated code
 * already merged in, so the caller controls exactly where the code lands
 * (e.g. spreading other validated fields around it).
 *
 * @param {object}   admin       supabase service-role client
 * @param {string}   table       table name
 * @param {string}   column      code column name
 * @param {string}   prefix      code prefix incl. trailing dash
 * @param {function} buildRow    (code:string) => object — the row to insert
 * @param {object}   [opts]
 * @param {string}   [opts.entityId]  entity scope for the count (optional)
 * @param {number}   [opts.pad=5]     zero-pad width
 * @param {string}   [opts.select]    PostgREST select string for the returned row
 * @param {number}   [opts.attempts=3]  number of generate→insert attempts
 * @returns {Promise<{ data?: object, error?: any }>}
 */
export async function insertWithAutoCode(admin, table, column, prefix, buildRow, opts = {}) {
  const { entityId = null, pad = 5, select = "*", attempts = 3 } = opts;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const code = await nextCode(admin, table, column, prefix, { entityId, pad, bump: attempt });
    const { data, error } = await admin
      .from(table)
      .insert(buildRow(code))
      .select(select)
      .single();
    if (!error) return { data };
    lastError = error;
    // 23505 = unique_violation. Another concurrent insert grabbed this number;
    // loop bumps the count and retries. Any other error is fatal.
    if (error.code !== "23505") break;
  }
  return { error: lastError };
}
