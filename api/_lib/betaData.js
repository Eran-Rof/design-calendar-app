// api/_lib/betaData.js
//
// Beta guardrails — Chunk C: the cleanup engine behind the Beta Data admin
// screen (api/_handlers/internal/beta-data/index.js).
//
// The beta_created_docs registry (chunk A) records every document/master row
// created while the beta window was active. This module decides, PER REGISTRY
// ROW and against LIVE data, whether that row can be safely deleted — and
// performs the delete when asked. Design rules (non-negotiable):
//
//   • POSTED documents are NEVER deleted — they must be REVERSED through the
//     normal posting engine (T11 reason required). The engine only refuses;
//     reversal is a human workflow.
//   • No bulk SQL. Every check and every delete is a per-row supabase-js op,
//     so RLS/service-role semantics and T11 audit triggers all apply normally.
//   • Never cascade beyond a document's OWN lines table. Anything else that
//     still references the row makes the DB refuse the delete (FK violation),
//     which we surface as a refusal — we never chase references.
//   • journal_entry_lines, GL tables, inventory ledgers and the beta tables
//     themselves are protected: a registry row naming them always refuses.
//     (Draft-JE deletes rely on the DB's own ON DELETE CASCADE for lines —
//     this code never issues a delete against journal_entry_lines.)
//
// The pure verdict functions (assess*) are unit-tested in
// api/_lib/__tests__/betaData.test.js with mock rows; the async orchestrators
// (evaluateRegistryRows / cleanupRegistryRows) take a service-role client and
// are exercised end-to-end via the handler.

// ─── Verdict helpers ─────────────────────────────────────────────────────────

const DELETABLE = Object.freeze({ verdict: "deletable" });
const ALREADY_GONE = Object.freeze({ verdict: "already_gone" });
const refuse = (reason) => ({ verdict: "refused", reason });

// ─── Protected tables — never touched, whatever the registry says ────────────
// Ledger/GL truth and the beta bookkeeping itself. A registry row pointing at
// one of these is a tagging bug, not a cleanup candidate.
export const PROTECTED_TABLES = new Set([
  "journal_entry_lines",
  "gl_accounts",
  "gl_periods",
  "xoro_gl_mirror",
  "row_changes",
  "inventory_ledger",
  "inv_ledger",
  "tangerine_size_onhand",
  "beta_config",
  "beta_created_docs",
]);

export function isProtectedTable(tableName) {
  const t = String(tableName || "").toLowerCase();
  if (PROTECTED_TABLES.has(t)) return true;
  // Defense in depth: anything that smells like GL or a movement ledger.
  return /^gl_/.test(t) || /_ledger$/.test(t);
}

// ─── Status helpers ──────────────────────────────────────────────────────────

// "Has this doc's gl_status reached posting?" The spec's literal
// `gl_status ILIKE '%post%'` would also match the DEFAULT value 'unposted'
// (which contains "post") and refuse every single document — so we deliberately
// treat 'unposted' / 'un-posted' as NOT posted. Everything else containing
// "post" (posted, post_pending, …) refuses.
export function isPostedGlStatus(glStatus) {
  const s = String(glStatus || "").toLowerCase();
  if (!s.includes("post")) return false;
  return !s.startsWith("unpost") && !s.startsWith("un-post");
}

const num = (v) => (v == null || v === "" ? 0 : Number(v) || 0);

// ─── Per-table verdicts (pure — doc row + pre-computed dependency counts) ────

// ar_invoices: posted (accrual/cash JE linked, or gl_status says posted) →
// reverse instead; any cash applied → keep for the money trail.
export function assessArInvoice(doc) {
  if (doc.accrual_je_id != null || doc.cash_je_id != null || isPostedGlStatus(doc.gl_status)) {
    return refuse("posted — reverse instead");
  }
  if (num(doc.paid_amount_cents) > 0) return refuse("has payments");
  return DELETABLE;
}

// invoices (AP bills): same pattern. Linkage cols per 20260527060000_p3_chunk1:
// accrual_je_id / cash_je_id / gl_status; payments live in invoice_payments
// (FK ON DELETE RESTRICT) and roll up into paid_amount_cents.
export function assessApInvoice(doc, deps = {}) {
  if (doc.accrual_je_id != null || doc.cash_je_id != null || isPostedGlStatus(doc.gl_status)) {
    return refuse("posted — reverse instead");
  }
  if (num(doc.paid_amount_cents) > 0 || num(deps.paymentCount) > 0) return refuse("has payments");
  return DELETABLE;
}

// journal_entries: only status='draft' is deletable (posted is immutable except
// via reversal; reversed is terminal). In this app most JEs are posted at
// creation by the posting engine, so most tagged JEs will refuse — that is
// intended. Deleting a draft header lets journal_entry_lines cascade via the
// DB FK (ON DELETE CASCADE); this engine never deletes lines directly.
export function assessJournalEntry(doc) {
  if (String(doc.status || "") !== "draft") return refuse("posted — reverse instead");
  return DELETABLE;
}

// ar_receipts: posted (JE-linked) → reverse/void instead; applied to any
// invoice (ar_receipt_applications) → unapply first.
export function assessArReceipt(doc, deps = {}) {
  if (doc.accrual_je_id != null || doc.cash_je_id != null) return refuse("posted — reverse instead");
  if (num(deps.applicationCount) > 0) return refuse("applied to invoices — unapply first");
  return DELETABLE;
}

// invoice_payments (AP): posted when its cash JE exists.
export function assessInvoicePayment(doc) {
  if (doc.cash_je_id != null) return refuse("posted — reverse instead");
  return DELETABLE;
}

// sales_orders: refuse when anything downstream exists — shipments rows, or
// any line qty allocated/shipped/invoiced.
export function assessSalesOrder(doc, deps = {}) {
  if (num(deps.shipmentCount) > 0
      || num(deps.allocatedQty) > 0
      || num(deps.shippedQty) > 0
      || num(deps.invoicedQty) > 0) {
    return refuse("has shipments/allocations");
  }
  return DELETABLE;
}

// purchase_orders: refuse when any line has received qty (the receipt leg
// lives ON the line — see project_three_way_match memory).
export function assessPurchaseOrder(doc, deps = {}) {
  if (num(deps.receivedQty) > 0) return refuse("has receipts");
  return DELETABLE;
}

// Generic strategy (customers, vendors, style_master, ip_item_master, cases,
// rfqs, inventory_adjustments, inventory_transfers, and any other table):
// refuse when the row carries an obvious posted-JE linkage; otherwise attempt
// the delete and let a FK violation refuse it ("still referenced").
export function assessGeneric(doc) {
  if (doc.accrual_je_id != null || doc.cash_je_id != null || doc.posted_je_id != null) {
    return refuse("posted — reverse instead");
  }
  if (isPostedGlStatus(doc.gl_status)) return refuse("posted — reverse instead");
  return DELETABLE;
}

// ─── Verdict dispatcher ──────────────────────────────────────────────────────

/**
 * Assess one registry row's target document.
 * @param {string} tableName   beta_created_docs.table_name
 * @param {object|null} doc    the live row (null/undefined = already gone)
 * @param {object} deps        pre-computed dependency counts for the table
 * @returns {{verdict: "deletable"|"refused"|"already_gone", reason?: string}}
 */
export function assessDoc(tableName, doc, deps = {}) {
  if (isProtectedTable(tableName)) return refuse("protected table — never cleaned by the beta engine");
  if (!doc) return ALREADY_GONE;
  switch (tableName) {
    case "ar_invoices":      return assessArInvoice(doc);
    case "invoices":         return assessApInvoice(doc, deps);
    case "journal_entries":  return assessJournalEntry(doc);
    case "ar_receipts":      return assessArReceipt(doc, deps);
    case "invoice_payments": return assessInvoicePayment(doc);
    case "sales_orders":     return assessSalesOrder(doc, deps);
    case "purchase_orders":  return assessPurchaseOrder(doc, deps);
    default:                 return assessGeneric(doc);
  }
}

// ─── Delete plan — the ONLY child table we ever delete per document ──────────
// (children-first; never anything beyond the doc's own lines table).
export const TABLE_RULES = {
  ar_invoices:     { lineTable: "ar_invoice_lines",     lineFk: "ar_invoice_id" },
  invoices:        { lineTable: "invoice_line_items",   lineFk: "invoice_id" },
  sales_orders:    { lineTable: "sales_order_lines",    lineFk: "sales_order_id" },
  purchase_orders: { lineTable: "purchase_order_lines", lineFk: "purchase_order_id" },
  rfqs:            { lineTable: "rfq_line_items",       lineFk: "rfq_id" },
  // journal_entries: draft-only; lines cascade via DB FK — never listed here.
};

// ─── Error → refusal text ────────────────────────────────────────────────────

/** Turn a PostgREST delete error into a human refusal reason. */
export function fkRefusalReason(error) {
  const msg = error?.message || String(error || "delete failed");
  if (error?.code === "23503" || /foreign key/i.test(msg)) {
    const m = msg.match(/constraint "([^"]+)"/);
    return `still referenced (${m ? m[1] : "foreign key"})`;
  }
  return `delete failed: ${msg}`;
}

// ─── Small utils ─────────────────────────────────────────────────────────────

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ─── Async orchestration (service-role client) ───────────────────────────────

// Batched .in() loads to keep a 500-row dry run to a handful of queries.
const IN_CHUNK = 200;

async function loadDocsByTable(admin, tableName, rowIds) {
  const byId = new Map();
  let loadError = null;
  for (const ids of chunk(rowIds, IN_CHUNK)) {
    const { data, error } = await admin.from(tableName).select("*").in("id", ids);
    if (error) { loadError = error.message; break; }
    for (const d of data || []) byId.set(d.id, d);
  }
  return { byId, loadError };
}

// Count/sum dependency rows for the tables whose verdicts need them.
async function loadDeps(admin, tableName, rowIds) {
  const deps = new Map(); // row_id → deps object
  const bump = (id, key, by) => {
    const d = deps.get(id) || {};
    d[key] = (d[key] || 0) + by;
    deps.set(id, d);
  };
  const scan = async (table, fkCol, cols, apply) => {
    for (const ids of chunk(rowIds, IN_CHUNK)) {
      const { data, error } = await admin.from(table).select(cols).in(fkCol, ids);
      if (error) throw new Error(`${table}: ${error.message}`);
      for (const r of data || []) apply(r);
    }
  };
  try {
    if (tableName === "invoices") {
      await scan("invoice_payments", "invoice_id", "invoice_id",
        (r) => bump(r.invoice_id, "paymentCount", 1));
    } else if (tableName === "ar_receipts") {
      await scan("ar_receipt_applications", "ar_receipt_id", "ar_receipt_id",
        (r) => bump(r.ar_receipt_id, "applicationCount", 1));
    } else if (tableName === "sales_orders") {
      await scan("sales_order_shipments", "sales_order_id", "sales_order_id",
        (r) => bump(r.sales_order_id, "shipmentCount", 1));
      await scan("sales_order_lines", "sales_order_id",
        "sales_order_id,qty_allocated,qty_shipped,qty_invoiced",
        (r) => {
          bump(r.sales_order_id, "allocatedQty", Number(r.qty_allocated) || 0);
          bump(r.sales_order_id, "shippedQty",   Number(r.qty_shipped)   || 0);
          bump(r.sales_order_id, "invoicedQty",  Number(r.qty_invoiced)  || 0);
        });
    } else if (tableName === "purchase_orders") {
      await scan("purchase_order_lines", "purchase_order_id",
        "purchase_order_id,qty_received",
        (r) => bump(r.purchase_order_id, "receivedQty", Number(r.qty_received) || 0));
    }
    return { deps, depsError: null };
  } catch (e) {
    return { deps, depsError: e.message };
  }
}

/**
 * Dry-run assessment of registry rows against live data — NO writes.
 * @param {object} admin service-role supabase client
 * @param {Array<{id:number|string, table_name:string, row_id:string}>} regRows
 * @returns {Promise<Map<number|string, {verdict:string, reason?:string}>>} keyed by registry id
 */
export async function evaluateRegistryRows(admin, regRows) {
  const out = new Map();
  const byTable = new Map();
  for (const r of regRows) {
    if (!byTable.has(r.table_name)) byTable.set(r.table_name, []);
    byTable.get(r.table_name).push(r);
  }
  for (const [tableName, rows] of byTable) {
    if (isProtectedTable(tableName)) {
      for (const r of rows) out.set(r.id, refuse("protected table — never cleaned by the beta engine"));
      continue;
    }
    const ids = rows.map((r) => r.row_id);
    const { byId, loadError } = await loadDocsByTable(admin, tableName, ids);
    if (loadError) {
      for (const r of rows) out.set(r.id, refuse(`cannot inspect: ${loadError}`));
      continue;
    }
    const { deps, depsError } = await loadDeps(admin, tableName, ids);
    if (depsError) {
      // Fail CLOSED: if we can't count dependents we refuse rather than guess.
      for (const r of rows) out.set(r.id, refuse(`cannot inspect dependents: ${depsError}`));
      continue;
    }
    for (const r of rows) {
      out.set(r.id, assessDoc(tableName, byId.get(r.row_id) || null, deps.get(r.row_id) || {}));
    }
  }
  return out;
}

async function markCleaned(admin, regId, note) {
  const { error } = await admin
    .from("beta_created_docs")
    .update({ cleaned_at: new Date().toISOString(), cleanup_note: note })
    .eq("id", regId);
  return error ? error.message : null;
}

/**
 * Run the cleanup on the given registry rows (already filtered to outstanding
 * by the handler). Re-evaluates each row against LIVE data immediately before
 * deleting, so a stale dry run can never delete a doc that got posted since.
 *
 * @param {object} admin service-role supabase client
 * @param {Array<object>} regRows beta_created_docs rows
 * @param {{actorLabel: string}} opts who to record in cleanup_note
 * @returns {Promise<Array<{id:any, table_name:string, outcome:"deleted"|"already_gone"|"refused", reason?:string}>>}
 */
export async function cleanupRegistryRows(admin, regRows, { actorLabel = "operator" } = {}) {
  const results = [];
  const assessments = await evaluateRegistryRows(admin, regRows);
  const stamp = new Date().toISOString();

  for (const reg of regRows) {
    const a = assessments.get(reg.id) || refuse("not assessed");

    if (a.verdict === "refused") {
      results.push({ id: reg.id, table_name: reg.table_name, outcome: "refused", reason: a.reason });
      continue;
    }

    if (a.verdict === "already_gone") {
      const err = await markCleaned(admin, reg.id, `already gone — marked cleaned by ${actorLabel} ${stamp}`);
      results.push({
        id: reg.id, table_name: reg.table_name, outcome: "already_gone",
        reason: err ? `row gone but registry update failed: ${err}` : "row no longer exists",
      });
      continue;
    }

    // Deletable → beta_cleanup_delete() RPC: lines + header in ONE transaction
    // (migration 20266100000000). Two sequential PostgREST deletes would leave
    // a header-without-lines document if the header delete refused on an
    // EXTERNAL FK after the lines were already gone; the plpgsql function rolls
    // both back together on any violation. (TABLE_RULES stays exported as the
    // documented mirror of the function's internal line-table allowlist.)
    const { data: rpcOut, error: delErr } = await admin.rpc("beta_cleanup_delete", {
      p_table: reg.table_name,
      p_row_id: reg.row_id,
    });
    if (delErr) {
      results.push({ id: reg.id, table_name: reg.table_name, outcome: "refused", reason: fkRefusalReason(delErr) });
      continue;
    }
    if (rpcOut === "not_found") {
      const goneErr = await markCleaned(admin, reg.id, `already gone — marked cleaned by ${actorLabel} ${stamp}`);
      results.push({
        id: reg.id, table_name: reg.table_name, outcome: "already_gone",
        reason: goneErr ? `row gone but registry update failed: ${goneErr}` : "row no longer exists",
      });
      continue;
    }
    const err = await markCleaned(admin, reg.id, `deleted by ${actorLabel} ${stamp}`);
    results.push({
      id: reg.id, table_name: reg.table_name, outcome: "deleted",
      reason: err ? `deleted but registry update failed: ${err}` : undefined,
    });
  }
  return results;
}
