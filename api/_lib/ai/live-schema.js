// Live schema introspection for the Ask AI panel.
//
// Calls the get_ai_readable_schema() Postgres function (see migration
// 20260516200000_ai_readable_schema.sql) once per cold start and caches
// the result in module scope. Returns a domain-shaped registry that
// merges with the curated registry in ai-schema.js — curated entries
// win on overlap because they carry hand-tuned descriptions + groupable
// / aggregatable flags.
//
// PII gating happens in two layers:
//   1. The Postgres function excludes whole tables that hold encrypted
//      or sensitive data (banking_details, virtual_cards, payments,
//      erp_integrations, edi_messages).
//   2. This module strips individual columns whose NAME matches one of
//      PII_COLUMN_PATTERNS (encrypted/hash suffix, password/secret/cvv/
//      card_number/account_number/routing_number prefix). Override
//      allowlist for safe `_last4` companion columns.
//
// Result shape matches ai-schema.js so callers can use lookupTable()
// and publicColumns() transparently.

// Column-name patterns that always indicate PII regardless of which
// table they appear in. Anything matching is dropped before reaching
// describe_table / query_table.
const PII_COLUMN_PATTERNS = [
  /_encrypted$/i,
  /_hash$/i,
  /^password/i,
  /(^|_)secret(_|$)/i,
  /(^|_)token(_|$)/i,             // catches *_token, secret_token, etc. but NOT auth_id / *_id
  /(^|_)(card_number|cvv|bank_account|routing_number|ssn|tax_id)(_|$)/i,
];

// Columns that match a PII pattern but are explicitly safe (e.g. only
// the last 4 digits are stored — common Stripe / Marqeta convention).
const PII_OVERRIDES = new Set([
  "card_number_last4",
  "account_number_last4",
  "ssn_last4",
]);

function isPiiColumn(name) {
  if (PII_OVERRIDES.has(name)) return false;
  return PII_COLUMN_PATTERNS.some(p => p.test(name));
}

// Map Postgres data_type strings to the simplified type names the
// query_table validator + ALLOWED_FILTER_OPS table expect.
function normalizeType(pgType) {
  const t = String(pgType || "").toLowerCase();
  if (t === "uuid") return "uuid";
  if (t === "boolean") return "bool";
  if (t === "integer" || t === "bigint" || t === "smallint") return "int";
  if (t === "numeric" || t === "real" || t === "double precision") return "numeric";
  if (t === "date") return "date";
  if (t.startsWith("timestamp")) return "date";  // close enough — PostgREST coerces YYYY-MM-DD
  if (t === "json" || t === "jsonb") return "json";
  if (t === "array" || t.endsWith("[]")) return "text[]";
  return "text";
}

// Heuristic for which columns make sense as a filter / group_by / agg
// target. Conservative: numeric → aggregatable; short scalars → filterable;
// short non-numeric / boolean → groupable; json / text body fields →
// nothing (operator wouldn't filter on a 10KB text column anyway).
function flagsForColumn(name, type) {
  const isText    = type === "text";
  const isUuid    = type === "uuid";
  const isBool    = type === "bool";
  const isDate    = type === "date";
  const isNumeric = type === "numeric" || type === "int";
  const isJson    = type === "json";

  // Long-text body columns are noise — filter them out by name
  // pattern (description/body/notes/raw_*/payload/content).
  const isLikelyBlob = /^(description|body|notes?|content|payload|raw_|response_|request_)/i.test(name);

  return {
    type,
    filterable:   !isJson && !isLikelyBlob,
    groupable:    !isJson && !isLikelyBlob && !isNumeric,
    aggregatable: isNumeric,
    date:         isDate,
  };
}

let LIVE_SCHEMA_CACHE = null;
let LIVE_SCHEMA_PROMISE = null;

// Load the live schema from Supabase. Memoised — first caller waits on
// the RPC; subsequent callers within the same cold start get the cached
// value instantly. Returns the "live_db" domain object in the same
// shape as ai-schema.js's DOMAINS entries.
export async function loadLiveSchema(db) {
  if (LIVE_SCHEMA_CACHE) return LIVE_SCHEMA_CACHE;
  if (LIVE_SCHEMA_PROMISE) return LIVE_SCHEMA_PROMISE;

  LIVE_SCHEMA_PROMISE = (async () => {
    let rows;
    try {
      const { data, error } = await db.rpc("get_ai_readable_schema");
      if (error) {
        // Function not deployed yet, or any other error — return an
        // empty live domain so the rest of the AI continues to work
        // off the curated registry. Don't throw; this is a fallback.
        console.warn(`[ai-live-schema] rpc failed: ${error.message}`);
        return makeDomain([]);
      }
      rows = data || [];
    } catch (err) {
      console.warn(`[ai-live-schema] exception: ${err?.message || err}`);
      return makeDomain([]);
    }
    return makeDomain(rows);
  })();

  LIVE_SCHEMA_CACHE = await LIVE_SCHEMA_PROMISE;
  return LIVE_SCHEMA_CACHE;
}

function makeDomain(rows) {
  // Group rows by table name; build a columns object per table with
  // PII columns stripped.
  const byTable = new Map();
  for (const r of rows) {
    if (!r.table_name || !r.column_name) continue;
    if (isPiiColumn(r.column_name)) continue;
    if (!byTable.has(r.table_name)) byTable.set(r.table_name, {});
    const cols = byTable.get(r.table_name);
    const type = normalizeType(r.data_type);
    cols[r.column_name] = flagsForColumn(r.column_name, type);
  }

  const tables = {};
  for (const [name, columns] of byTable) {
    tables[name] = {
      description: `Live-discovered public table. ${Object.keys(columns).length} readable columns.`,
      columns,
      source: "live",
    };
  }

  return {
    domain: "live_db",
    description: "Auto-discovered public-schema tables. Use when the curated domains (po_wip / vendor_portal / planning / design_calendar) don't cover what you need. Column flags are conservative defaults — long-text/json columns are excluded from filter/group/agg.",
    tables,
  };
}

// For tests / dev: reset cache so unit tests can re-load.
export function _resetLiveSchemaCacheForTests() {
  LIVE_SCHEMA_CACHE = null;
  LIVE_SCHEMA_PROMISE = null;
}
