// api/internal/users/me/preferences/table-visibility
//
// Universal Column Visibility (Operator ask #1, 2026-05-30):
//   "In all user viewable windows with columns, add ability to view or hide
//    any column. Add save UI function so each user can save their own UI."
//
// PUT body: { tables: { [tableKey: string]: string[] /* hidden column keys */ } }
//
//   • Reads the existing user_preferences row at key='table_visibility'
//     (if any), merges in the supplied tables map, and upserts the result.
//     Merge semantics: the request replaces the per-tableKey array (not a
//     per-column toggle). An empty array clears the hidden set for that
//     table; an entirely missing tableKey preserves whatever was previously
//     stored for that table.
//   • A future "reset to default" client call sends `{ tables: { foo: [] } }`
//     which collapses the hidden set for that one panel without disturbing
//     prefs for any other panel.
//   • Returns the merged value the same shape the front-end stores.
//
// No new DB columns — the schema already has user_preferences (user_id,
// entity_id, key, value JSONB). This handler simply registers a new known
// `key` value ("table_visibility") alongside favorites / home_route /
// drawer_collapsed.
//
// Auth — Bearer JWT, identical to the favorites + home-route handlers.

import { createClient } from "@supabase/supabase-js";
import { authenticateCaller } from "../../../../../_lib/auth.js";

export const config = { maxDuration: 10 };

const MAX_TABLES_PER_USER = 200;       // sanity ceiling on number of distinct panels
const MAX_HIDDEN_PER_TABLE = 200;       // sanity ceiling on hidden columns per panel
const MAX_KEY_LENGTH = 120;             // table_key + column_key max length

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function resolveDefaultEntityId(admin) {
  const { data, error } = await admin
    .from("entities")
    .select("id")
    .eq("code", "ROF")
    .maybeSingle();
  if (error || !data) return null;
  return data.id;
}

/**
 * Pure validator for the table-visibility body. Exported so unit tests
 * can hit it without spinning up the supabase mock.
 *
 * Accepts:
 *   { tables: { [tableKey: string]: string[] } }
 *
 * Returns either { data: { tables } } or { error: string }.
 *
 * @param {unknown} body
 * @returns {{data?: {tables: Record<string, string[]>}, error?: string}}
 */
export function validateTableVisibilityBody(body) {
  if (!body || typeof body !== "object") {
    return { error: "Body must be a JSON object" };
  }
  const { tables } = /** @type {Record<string, unknown>} */ (body);
  if (!tables || typeof tables !== "object" || Array.isArray(tables)) {
    return { error: "tables must be an object keyed by tableKey" };
  }
  const tableEntries = Object.entries(tables);
  if (tableEntries.length > MAX_TABLES_PER_USER) {
    return {
      error: `tables may contain at most ${MAX_TABLES_PER_USER} entries (got ${tableEntries.length})`,
    };
  }
  const out = /** @type {Record<string, string[]>} */ ({});
  for (const [tableKey, hidden] of tableEntries) {
    if (typeof tableKey !== "string" || tableKey.length === 0) {
      return { error: "every tableKey must be a non-empty string" };
    }
    if (tableKey.length > MAX_KEY_LENGTH) {
      return { error: `tableKey too long (>${MAX_KEY_LENGTH}): ${tableKey.slice(0, 40)}…` };
    }
    if (!Array.isArray(hidden)) {
      return { error: `tables.${tableKey} must be an array of hidden column keys` };
    }
    if (hidden.length > MAX_HIDDEN_PER_TABLE) {
      return {
        error: `tables.${tableKey} may contain at most ${MAX_HIDDEN_PER_TABLE} entries (got ${hidden.length})`,
      };
    }
    const seen = new Set();
    const arr = [];
    for (const col of hidden) {
      if (typeof col !== "string" || col.length === 0) {
        return { error: `every entry in tables.${tableKey} must be a non-empty string` };
      }
      if (col.length > MAX_KEY_LENGTH) {
        return { error: `column key in tables.${tableKey} too long (>${MAX_KEY_LENGTH})` };
      }
      if (seen.has(col)) continue; // de-dupe silently
      seen.add(col);
      arr.push(col);
    }
    out[tableKey] = arr;
  }
  return { data: { tables: out } };
}

/**
 * Merge an incoming `tables` patch into an existing stored `tables` object.
 * Each tableKey present in the patch REPLACES the stored array for that
 * tableKey. tableKeys absent from the patch are preserved untouched.
 *
 * Exported so unit tests can verify the merge semantics directly.
 *
 * @param {Record<string, string[]> | undefined | null} stored
 * @param {Record<string, string[]>} patch
 * @returns {Record<string, string[]>}
 */
export function mergeTables(stored, patch) {
  /** @type {Record<string, string[]>} */
  const out = {};
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const [k, v] of Object.entries(stored)) {
      if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === "string");
    }
  }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = [...v];
  }
  return out;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "PUT") {
    res.setHeader("Allow", "PUT");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const auth = await authenticateCaller(req, admin);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const v = validateTableVisibilityBody(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  // Read existing row (if any) so we can merge per-tableKey.
  const { data: existing, error: readErr } = await admin
    .from("user_preferences")
    .select("value")
    .eq("user_id", auth.authId)
    .eq("entity_id", entityId)
    .eq("key", "table_visibility")
    .maybeSingle();
  if (readErr) return res.status(500).json({ error: readErr.message });

  const storedTables =
    existing && existing.value && typeof existing.value === "object" && !Array.isArray(existing.value)
      ? existing.value.tables
      : null;
  const mergedTables = mergeTables(storedTables, v.data.tables);

  const row = {
    user_id: auth.authId,
    entity_id: entityId,
    key: "table_visibility",
    value: { tables: mergedTables, v: 1 },
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await admin
    .from("user_preferences")
    .upsert(row, { onConflict: "user_id,entity_id,key" })
    .select("key, value")
    .single();
  if (error) return res.status(500).json({ error: error.message });

  return res
    .status(200)
    .json({ key: data?.key ?? "table_visibility", value: data?.value ?? row.value });
}
