// api/internal/audit/log
//
// Cross-cutter T11-3 — read-only handler that returns the full
// `row_changes` ledger with optional filters. Powers the operator-facing
// <InternalAuditLog /> admin panel.
//
//   GET /api/internal/audit/log?
//        entity_id=<uuid>                    (optional)
//       &source_table=ar_invoices            (optional, allowlist-validated when present)
//       &actor=<employee uuid>               (optional)
//       &operation=INSERT,VOID,POST          (optional, comma-separated set)
//       &from=YYYY-MM-DD                     (optional inclusive lower bound on changed_at)
//       &to=YYYY-MM-DD                       (optional inclusive upper bound on changed_at)
//       &limit=100                           (optional, default 100, max 500)
//       &offset=0                            (optional)
//
// Returns:
//   200 {
//     count, limit, offset,
//     changes: [ ...row_changes-shape with display_name/source_table ... ]
//   }
//
// 401 / 400 / 500.
//
// DateRangePresets-compatible: the from/to params accept the same
// YYYY-MM-DD shape the T7 component emits. `from` becomes
// `changed_at >= from 00:00 UTC`; `to` becomes `changed_at < to+1 day
// 00:00 UTC` (inclusive end-of-day semantics).

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";
import {
  T11_ALLOWED_SOURCE_TABLES,
  pickDisplayName,
} from "./row-history.js";

export const config = { maxDuration: 15 };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const AUDIT_OPERATIONS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "VOID",
  "POST",
  "REVERSE",
];

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
 * verify allowlist + uuid + date / bounds logic without supabase.
 *
 * Returns { data: { ... } } on success, { error: string } on failure.
 */
export function parseAuditLogQuery(params) {
  const out = {
    entity_id: null,
    source_table: null,
    actor: null,
    operations: null,
    from: null,
    to: null,
    limit: 100,
    offset: 0,
  };

  if (params.entity_id !== undefined && params.entity_id !== "") {
    const v = String(params.entity_id).trim();
    if (!UUID_RE.test(v)) {
      return { error: `entity_id must be a uuid (got "${v}")` };
    }
    out.entity_id = v;
  }

  if (params.source_table !== undefined && params.source_table !== "") {
    const v = String(params.source_table).trim();
    if (!T11_ALLOWED_SOURCE_TABLES.includes(v)) {
      return {
        error:
          `source_table "${v}" is not in the T11 audit coverage allowlist. ` +
          `Valid: ${T11_ALLOWED_SOURCE_TABLES.join(", ")}.`,
      };
    }
    out.source_table = v;
  }

  if (params.actor !== undefined && params.actor !== "") {
    const v = String(params.actor).trim();
    if (!UUID_RE.test(v)) {
      return { error: `actor must be an employee uuid (got "${v}")` };
    }
    out.actor = v;
  }

  if (params.operation !== undefined && params.operation !== "") {
    const ops = String(params.operation)
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    for (const op of ops) {
      if (!AUDIT_OPERATIONS.includes(op)) {
        return {
          error:
            `operation "${op}" is not valid. ` +
            `Valid: ${AUDIT_OPERATIONS.join(", ")}.`,
        };
      }
    }
    out.operations = ops.length > 0 ? ops : null;
  }

  if (params.from !== undefined && params.from !== "") {
    const v = String(params.from).trim();
    if (!DATE_RE.test(v)) {
      return { error: `from must be YYYY-MM-DD (got "${v}")` };
    }
    out.from = v;
  }

  if (params.to !== undefined && params.to !== "") {
    const v = String(params.to).trim();
    if (!DATE_RE.test(v)) {
      return { error: `to must be YYYY-MM-DD (got "${v}")` };
    }
    out.to = v;
  }

  if (out.from && out.to && out.from > out.to) {
    return { error: "from must be <= to" };
  }

  if (params.limit !== undefined && params.limit !== "") {
    const n = parseInt(String(params.limit), 10);
    if (!Number.isFinite(n) || n <= 0) {
      return { error: "limit must be a positive integer" };
    }
    out.limit = Math.min(500, n);
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
 * Convert a YYYY-MM-DD to its inclusive end-of-day boundary as an ISO
 * timestamp. We use the next-day-00:00 trick so we can use a strict `<`
 * comparison server-side, which matches PG's btree behaviour cleanly.
 *
 * Pure — exported for tests.
 */
export function endOfDayBoundary(yyyymmdd) {
  if (!DATE_RE.test(yyyymmdd)) return null;
  const d = new Date(`${yyyymmdd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

export function startOfDayBoundary(yyyymmdd) {
  if (!DATE_RE.test(yyyymmdd)) return null;
  return `${yyyymmdd}T00:00:00.000Z`;
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

  // Read-only internal audit-log viewer — gate with INTERNAL_API_TOKEN (the
  // standard internal "is this our frontend" check, accepts the static deploy
  // token via Bearer OR X-Internal-Token), NOT the per-user authenticateCaller.
  // Requiring a live per-user JWT here 401'd ("Invalid or expired token") for
  // users with no/expired user token; this is a SELECT that needs no actor.
  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const params = Object.fromEntries(url.searchParams.entries());
  const v = parseAuditLogQuery(params);
  if (v.error) return res.status(400).json({ error: v.error });

  const f = v.data;

  let query = admin
    .from("row_changes")
    .select(
      "id, entity_id, source_table, source_id, operation, " +
        "before_jsonb, after_jsonb, changed_columns, " +
        "actor_auth_id, actor_employee_id, actor_display_name, " +
        "source, reason, correlation_id, changed_at",
    )
    .order("changed_at", { ascending: false })
    .range(f.offset, f.offset + f.limit - 1);

  if (f.entity_id) query = query.eq("entity_id", f.entity_id);
  if (f.source_table) query = query.eq("source_table", f.source_table);
  if (f.actor) query = query.eq("actor_employee_id", f.actor);
  if (f.operations && f.operations.length > 0) {
    query = query.in("operation", f.operations);
  }
  if (f.from) {
    const lo = startOfDayBoundary(f.from);
    if (lo) query = query.gte("changed_at", lo);
  }
  if (f.to) {
    const hi = endOfDayBoundary(f.to);
    if (hi) query = query.lt("changed_at", hi);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Best-effort enrichment for rows that don't carry a cached display_name.
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
    entity_id: r.entity_id,
    source_table: r.source_table,
    source_id: r.source_id,
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
    count: changes.length,
    limit: f.limit,
    offset: f.offset,
    changes,
  });
}
