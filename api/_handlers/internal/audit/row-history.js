// api/internal/audit/row-history
//
// Cross-cutter T11-3 — read-only handler that returns the per-row audit
// timeline for a single (source_table, source_id) pair on the T11
// `row_changes` ledger. Powers the <RowHistory /> drop-in component
// rendered inside the nine T11 detail modals (AR/AP invoice, JE,
// customer/vendor, employee, case, GL account, virtual card).
//
//   GET /api/internal/audit/row-history?
//        source_table=ar_invoices            (required, allowlisted)
//       &source_id=<uuid>                    (required)
//       &limit=50                            (optional, default 50, max 200)
//       &offset=0                            (optional)
//
// Returns:
//   200 {
//     source_table, source_id, count,
//     changes: [
//       {
//         id, operation, changed_at,
//         actor_auth_id, actor_employee_id, actor_display_name,
//         source, reason, correlation_id,
//         changed_columns: string[],
//         before_jsonb, after_jsonb
//       },
//       ...
//     ]
//   }
//
// 401 — missing/invalid bearer
// 400 — missing/invalid params, or source_table not in the T11-1
//       16-entity allowlist
// 500 — server mis-configuration or supabase error
//
// Author note: this is a SELECT-only handler. The T11-1 trigger is the
// sole writer to row_changes; this surface never INSERTs/UPDATEs.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";

export const config = { maxDuration: 10 };

// T11-1 §3 — 16-entity coverage allowlist. Kept in sync with the table
// list inside the T11-1 migration's DO $$ block.
export const T11_ALLOWED_SOURCE_TABLES = [
  "ar_invoices",
  "ar_invoice_lines",
  "invoices",
  "invoice_line_items",
  "journal_entries",
  "journal_entry_lines",
  "gl_accounts",
  "gl_periods",
  "customers",
  "vendors",
  "employees",
  "cases",
  "sales_reps",
  "commission_payouts",
  "bank_accounts",
  "virtual_cards",
  "purchase_orders",
  "purchase_order_lines",
];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

/**
 * Validate the GET query string. Pure — exported for unit tests so we can
 * exercise the allowlist + uuid + bounds logic without spinning Supabase.
 */
export function parseRowHistoryQuery(params) {
  const out = { source_table: "", source_id: "", limit: 50, offset: 0 };

  const source_table = String(params.source_table || "").trim();
  if (!source_table) {
    return { error: "source_table is required" };
  }
  if (!T11_ALLOWED_SOURCE_TABLES.includes(source_table)) {
    return {
      error:
        `source_table "${source_table}" is not in the T11 audit coverage ` +
        `allowlist. Valid: ${T11_ALLOWED_SOURCE_TABLES.join(", ")}.`,
    };
  }
  out.source_table = source_table;

  const source_id = String(params.source_id || "").trim();
  if (!source_id) {
    return { error: "source_id is required" };
  }
  // Most covered tables use uuid PKs; gl_periods uses a uuid too per
  // the T11-1 migration. Reject malformed values to keep the index hot.
  if (!UUID_RE.test(source_id)) {
    return { error: `source_id must be a uuid (got "${source_id}")` };
  }
  out.source_id = source_id;

  if (params.limit !== undefined && params.limit !== "") {
    const n = parseInt(String(params.limit), 10);
    if (!Number.isFinite(n) || n <= 0) {
      return { error: "limit must be a positive integer" };
    }
    out.limit = Math.min(200, n);
  }

  if (params.offset !== undefined && params.offset !== "") {
    const n = parseInt(String(params.offset), 10);
    if (!Number.isFinite(n) || n < 0) {
      return { error: "offset must be a non-negative integer" };
    }
    out.offset = n;
  }

  return { data: out };
}

/**
 * Resolve actor_display_name for changes whose row_changes row already
 * carries a cached display_name (the common case — set by T11-2
 * withAuditContext at write-time). For rows that have an
 * `actor_employee_id` but no cached `actor_display_name` (e.g. legacy
 * inserts written before T11-2 shipped, or via the trigger's failure
 * fall-through), do a best-effort batch lookup against the employees
 * table.
 *
 * Pure-ish: exported so tests can assert the resolution math without
 * the supabase round-trip.
 */
export function pickDisplayName(row, employees) {
  if (row.actor_display_name && String(row.actor_display_name).trim()) {
    return row.actor_display_name;
  }
  if (row.actor_employee_id && employees[row.actor_employee_id]) {
    const e = employees[row.actor_employee_id];
    return (
      e.full_name ||
      [e.first_name, e.last_name].filter(Boolean).join(" ") ||
      e.email ||
      null
    );
  }
  return null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // Read-only internal-staff surface — gate with the same INTERNAL_API_TOKEN
  // "is this our frontend" check every other /api/internal/** handler uses
  // (accepts the static deploy token via Bearer OR X-Internal-Token). NOT the
  // per-user `authenticateCaller`: this is a SELECT, the rows already carry the
  // actor, and requiring a live per-user JWT here 401'd the Audit Trail panel
  // ("Invalid or expired token") whenever a user had no/expired user token
  // (e.g. entered Tangerine via the PLM-session fallback, or past the 12h JWT).
  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const params = Object.fromEntries(url.searchParams.entries());
  const v = parseRowHistoryQuery(params);
  if (v.error) return res.status(400).json({ error: v.error });

  const { source_table, source_id, limit, offset } = v.data;

  const { data, error } = await admin
    .from("row_changes")
    .select(
      "id, entity_id, source_table, source_id, operation, " +
        "before_jsonb, after_jsonb, changed_columns, " +
        "actor_auth_id, actor_employee_id, actor_display_name, " +
        "source, reason, correlation_id, changed_at",
    )
    .eq("source_table", source_table)
    .eq("source_id", source_id)
    .order("changed_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return res.status(500).json({ error: error.message });

  // Best-effort enrichment: resolve display_name for rows that don't
  // carry a cached value but do reference an employee. Single batch
  // fetch keyed by the distinct employee_id set.
  const empIds = Array.from(
    new Set(
      (data || [])
        .filter((r) => !r.actor_display_name && r.actor_employee_id)
        .map((r) => r.actor_employee_id),
    ),
  );
  let employees = {};
  if (empIds.length > 0) {
    const { data: edata } = await admin
      .from("employees")
      .select("id, full_name, first_name, last_name, email")
      .in("id", empIds);
    for (const e of edata || []) employees[e.id] = e;
  }

  const changes = (data || []).map((r) => ({
    id: r.id,
    operation: r.operation,
    changed_at: r.changed_at,
    actor_auth_id: r.actor_auth_id,
    actor_employee_id: r.actor_employee_id,
    actor_display_name: pickDisplayName(r, employees),
    source: r.source,
    reason: r.reason,
    correlation_id: r.correlation_id,
    changed_columns: Array.isArray(r.changed_columns) ? r.changed_columns : [],
    before_jsonb: r.before_jsonb,
    after_jsonb: r.after_jsonb,
  }));

  return res.status(200).json({
    source_table,
    source_id,
    count: changes.length,
    changes,
  });
}
