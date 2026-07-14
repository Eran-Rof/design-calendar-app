// Tool executors for the Ask AI handler.
//
// Every tool here is read-only, allowlisted, parameterised. NO raw
// SQL, NO string interpolation into PostgREST URLs. Errors return a
// structured `{ error }` payload so Claude can recover rather than
// crashing the loop.
//
// Architecture: one module-level export `TOOL_EXECUTORS` is the
// dispatcher map consumed by the handler + streaming loop. The
// executor signature is uniform: `async (db, input) => result`.
// Terminal tools (apply_filters / set_sort / clear_filters /
// answer_text / suggest_grid_view) are handled inline by the loop
// and never reach this map.

import {
  DOMAINS,
  ALLOWED_FILTER_OPS,
  ALLOWED_AGGS,
  lookupTable,
  publicColumns,
} from "./schema.js";
import { loadLiveSchema } from "./live-schema.js";
import {
  canonName,
  clampString,
  clampDate,
  monthKey,
} from "./utils.js";
import {
  FIND_CUSTOMER_LIMIT,
  FIND_STYLE_LIMIT,
  QUERY_ROW_LIMIT,
  QUERY_RESULT_LIMIT,
} from "./constants.js";
import { tool_style_card, tool_customer_card } from "./executors-cards.js";
import { tool_query_margin } from "./executors-margin.js";
import { tool_lookup_user_facts } from "./executors-user-facts.js";
import { tool_start_workflow } from "./workflows.js";
import { searchUserGuide } from "./userGuide.js";
import { tool_get_today } from "./executors-today.js";
import { tool_run_action } from "./executors-actions.js";

// ─────────────────────────────────────────────────────────────────────
// Schema merging — curated registry + live introspection
// ─────────────────────────────────────────────────────────────────────

// Curated entries win on overlap (they carry hand-tuned descriptions).
// The live domain is added as a fifth bucket so Claude can
// `list_tables('live_db')` to see everything else that exists in the database.
export async function getMergedDomains(db) {
  const live = await loadLiveSchema(db);
  const curatedTableNames = new Set();
  for (const d of Object.values(DOMAINS)) {
    for (const t of Object.keys(d.tables)) curatedTableNames.add(t);
  }
  const liveTables = {};
  for (const [name, t] of Object.entries(live.tables)) {
    if (!curatedTableNames.has(name)) liveTables[name] = t;
  }
  return {
    ...DOMAINS,
    live_db: { ...live, tables: liveTables },
  };
}

// Lookup that consults curated + live. Tries curated first to avoid
// the RPC round-trip when possible.
export async function mergedLookupTable(db, domainName, tableName) {
  if (domainName) {
    const curated = lookupTable(domainName, tableName);
    if (curated) return curated;
  } else {
    for (const [dn, d] of Object.entries(DOMAINS)) {
      if (d.tables[tableName]) return lookupTable(dn, tableName);
    }
  }
  const merged = await getMergedDomains(db);
  if (domainName) {
    const dom = merged[domainName];
    if (dom?.tables[tableName]) return { domain: dom, table: dom.tables[tableName], tableName, domainName };
  } else {
    for (const [dn, d] of Object.entries(merged)) {
      if (d.tables[tableName]) return { domain: d, table: d.tables[tableName], tableName, domainName: dn };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Filter validator (used by query_table)
// ─────────────────────────────────────────────────────────────────────

// Validate + apply a single filter to a PostgREST query builder. Returns
// { ok, q? , error? }. Op + column must be in the allowlist for that
// column type, and `in` values must be a non-empty array.
export function applyFilter(q, table, { col, op, value }) {
  const meta = publicColumns(table)[col];
  if (!meta) return { ok: false, error: `Column '${col}' is not readable.` };
  if (!meta.filterable) return { ok: false, error: `Column '${col}' is not filterable.` };
  const allowed = ALLOWED_FILTER_OPS[meta.type] || [];
  if (!allowed.includes(op)) {
    return { ok: false, error: `Op '${op}' not allowed on '${col}' (type ${meta.type}). Allowed: ${allowed.join(", ")}.` };
  }
  switch (op) {
    case "eq":   q = q.eq(col, value); break;
    case "neq":  q = q.neq(col, value); break;
    case "gt":   q = q.gt(col, value); break;
    case "gte":  q = q.gte(col, value); break;
    case "lt":   q = q.lt(col, value); break;
    case "lte":  q = q.lte(col, value); break;
    case "in":
      if (!Array.isArray(value) || value.length === 0) return { ok: false, error: `'in' requires non-empty array for '${col}'.` };
      if (value.length > 50) return { ok: false, error: `'in' list capped at 50 values.` };
      q = q.in(col, value);
      break;
    case "ilike": q = q.ilike(col, String(value)); break;
    case "is_null":     q = q.is(col, null); break;
    case "not_is_null": q = q.not(col, "is", null); break;
  }
  return { ok: true, q };
}

// ─────────────────────────────────────────────────────────────────────
// Hot-path tools — specialised for the most common ATS questions
// ─────────────────────────────────────────────────────────────────────

async function tool_find_customer(db, input) {
  const q = clampString(input?.name_contains, 100).trim();
  if (!q) return { error: "name_contains required" };
  const firstWord = q.split(/\s+/)[0] || q;
  const target = canonName(q);

  const { data, error } = await db
    .from("ip_customer_master")
    .select("id, name, customer_code")
    .ilike("name", `${firstWord}%`)
    .limit(FIND_CUSTOMER_LIMIT);
  if (error) return { error: error.message };

  const scored = (data || []).map(r => {
    const c = canonName(r.name);
    const exact = c === target ? 2 : (c.startsWith(target) || target.startsWith(c) ? 1 : 0);
    return { ...r, _score: exact };
  }).sort((a, b) => b._score - a._score);

  return {
    matches: scored.slice(0, FIND_CUSTOMER_LIMIT).map(r => ({
      id: r.id, name: r.name, customer_code: r.customer_code,
    })),
    count: scored.length,
  };
}

async function tool_find_style(db, input) {
  const q = clampString(input?.query, 100).trim();
  if (!q) return { error: "query required" };
  const enc = `%${q}%`;

  const { data, error } = await db
    .from("ip_item_master")
    .select("sku_code, style_code, description, color, size, active")
    .or(`sku_code.ilike.${enc},style_code.ilike.${enc},description.ilike.${enc}`)
    .eq("active", true)
    .limit(FIND_STYLE_LIMIT * 4);
  if (error) return { error: error.message };

  const byStyle = new Map();
  for (const r of (data || [])) {
    const key = r.style_code || r.sku_code;
    if (!key) continue;
    if (!byStyle.has(key)) {
      byStyle.set(key, {
        style_code: r.style_code,
        sample_description: r.description || null,
        sku_count: 0,
        sample_skus: [],
      });
    }
    const acc = byStyle.get(key);
    acc.sku_count += 1;
    if (acc.sample_skus.length < 5) acc.sample_skus.push(r.sku_code);
  }
  const styles = Array.from(byStyle.values()).slice(0, FIND_STYLE_LIMIT);
  return { styles, count: byStyle.size };
}

// Resolve style_code / sku_code to a set of ip_item_master.id values
// so the query tools can filter on the FK column (sku_id).
async function resolveSkuIdsForStyleOrSku(db, { style_code, sku_code }) {
  if (!style_code && !sku_code) return null;
  let q = db.from("ip_item_master").select("id, sku_code, style_code").limit(2000);
  if (style_code) q = q.eq("style_code", style_code);
  if (sku_code)   q = q.eq("sku_code", sku_code);
  const { data, error } = await q;
  if (error) return { error: error.message };
  return { ids: (data || []).map(r => r.id), rows: data || [] };
}

async function tool_query_shipments(db, input) {
  const date_from = clampDate(input?.date_from);
  const date_to   = clampDate(input?.date_to);
  if (!date_from || !date_to) return { error: "date_from and date_to required (YYYY-MM-DD)" };

  const skuIdsResolved = await resolveSkuIdsForStyleOrSku(db, input);
  if (skuIdsResolved?.error) return { error: skuIdsResolved.error };
  const skuIds = skuIdsResolved?.ids ?? null;
  if (skuIds && skuIds.length === 0) {
    return { groups: [], note: "No SKUs matched the supplied style_code/sku_code." };
  }

  // Customer narrowing accepts either customer_ids (array, preferred —
  // catches Xoro spelling drift where one logical customer maps to
  // many master rows) OR customer_id (singular, legacy). Coerced to a
  // unified list so .in() always fires when narrowing.
  const customerIds = Array.isArray(input?.customer_ids) && input.customer_ids.length > 0
    ? input.customer_ids.filter(id => typeof id === "string" && id.length > 0)
    : (input?.customer_id ? [input.customer_id] : null);

  let q = db
    .from("ip_sales_history_wholesale")
    .select("sku_id, customer_id, txn_date, txn_type, qty, net_amount")
    .gte("txn_date", date_from)
    .lte("txn_date", date_to)
    .limit(QUERY_ROW_LIMIT);
  if (customerIds && customerIds.length > 0) q = q.in("customer_id", customerIds);
  if (input?.txn_type)                       q = q.eq("txn_type",    input.txn_type);
  if (skuIds)                                q = q.in("sku_id", skuIds);

  const { data, error } = await q;
  if (error) return { error: error.message };

  // Pull pack_size alongside sku/style mapping so groups can surface
  // is_prepack — lets Claude separate prepack vs non-prepack rows in
  // the answer instead of guessing at grain. Fetched for non-customer
  // groupings since customer doesn't carry pack info anyway.
  const seenSkuIds = Array.from(new Set((data || []).map(r => r.sku_id).filter(Boolean)));
  let skuToStyle = new Map();
  let skuToCode  = new Map();
  let skuToPack  = new Map();
  if (seenSkuIds.length > 0 && (input?.group_by ?? "style") !== "customer") {
    const { data: masters } = await db
      .from("ip_item_master")
      .select("id, sku_code, style_code, pack_size")
      .in("id", seenSkuIds);
    for (const m of (masters || [])) {
      if (m.style_code) skuToStyle.set(m.id, m.style_code);
      if (m.sku_code)   skuToCode.set(m.id, m.sku_code);
      const ps = Number(m.pack_size || 1);
      skuToPack.set(m.id, ps > 0 ? ps : 1);
    }
  }

  const groupBy = input?.group_by ?? "style";
  const groups = new Map();
  for (const r of (data || [])) {
    let key;
    switch (groupBy) {
      case "sku":      key = skuToCode.get(r.sku_id) || r.sku_id; break;
      case "customer": key = r.customer_id || "(no customer)";    break;
      case "month":    key = monthKey(r.txn_date);                break;
      case "style":
      default:         key = skuToStyle.get(r.sku_id) || skuToCode.get(r.sku_id) || "(unmatched)"; break;
    }
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        qty: 0,
        net_amount: 0,
        row_count: 0,
        pack_size: groupBy === "customer" || groupBy === "month" ? null : 1,
      });
    }
    const g = groups.get(key);
    g.qty        += Number(r.qty || 0);
    g.net_amount += Number(r.net_amount || 0);
    g.row_count  += 1;
    if (groupBy !== "customer" && groupBy !== "month") {
      // Take the MAX pack_size across rows in the group — handles the
      // edge case where one logical style has both a prepack variant
      // and a non-prepack one and they merge in 'style' grouping.
      const ps = skuToPack.get(r.sku_id) ?? 1;
      if (ps > (g.pack_size ?? 1)) g.pack_size = ps;
    }
  }
  const out = Array.from(groups.values())
    .map(g => ({ ...g, is_prepack: (g.pack_size ?? 1) > 1 }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, QUERY_RESULT_LIMIT);
  const totalQty = out.reduce((s, g) => s + g.qty, 0);
  const totalAmt = out.reduce((s, g) => s + g.net_amount, 0);
  // Pre-split totals so Claude can write the answer without inferring.
  const prepackGroups = out.filter(g => g.is_prepack);
  const nonPrepackGroups = out.filter(g => !g.is_prepack);
  const prepackQty    = prepackGroups.reduce((s, g) => s + g.qty, 0);
  const nonPrepackQty = nonPrepackGroups.reduce((s, g) => s + g.qty, 0);
  const prepackAmt    = prepackGroups.reduce((s, g) => s + g.net_amount, 0);
  const nonPrepackAmt = nonPrepackGroups.reduce((s, g) => s + g.net_amount, 0);
  return {
    groups: out,
    group_count: groups.size,
    row_count: (data || []).length,
    capped: (data || []).length >= QUERY_ROW_LIMIT,
    totals: { qty: totalQty, net_amount: totalAmt },
    totals_by_grain: (groupBy === "customer" || groupBy === "month") ? null : {
      non_prepack: { style_count: nonPrepackGroups.length, qty: nonPrepackQty, net_amount: nonPrepackAmt },
      prepack:     { style_count: prepackGroups.length,    qty: prepackQty,    net_amount: prepackAmt },
      note: "Sales qty is at Xoro's recorded grain. Non-prepack rows are unit-grain. Prepack rows are pack-grain — multiply by each group's pack_size to convert to units. DO NOT speculate; the breakdown above is authoritative.",
    },
    group_by: groupBy,
  };
}

async function tool_query_open_sos(db, input) {
  const skuIdsResolved = await resolveSkuIdsForStyleOrSku(db, input);
  if (skuIdsResolved?.error) return { error: skuIdsResolved.error };
  const skuIds = skuIdsResolved?.ids ?? null;
  if (skuIds && skuIds.length === 0) {
    return { groups: [], note: "No SKUs matched the supplied style_code/sku_code." };
  }

  // Same customer narrowing pattern as tool_query_shipments — prefer
  // customer_ids array (Xoro spelling drift), fall back to singular.
  const customerIds = Array.isArray(input?.customer_ids) && input.customer_ids.length > 0
    ? input.customer_ids.filter(id => typeof id === "string" && id.length > 0)
    : (input?.customer_id ? [input.customer_id] : null);

  let q = db
    .from("ip_open_sales_orders")
    .select("sku_id, customer_id, customer_name, ship_date, qty_ordered, qty_shipped, qty_open, unit_price")
    .limit(QUERY_ROW_LIMIT);
  if (customerIds && customerIds.length > 0) q = q.in("customer_id", customerIds);
  if (skuIds)                                q = q.in("sku_id", skuIds);
  if (input?.date_from) {
    const d = clampDate(input.date_from);
    if (!d) return { error: "date_from must be YYYY-MM-DD" };
    q = q.gte("ship_date", d);
  }
  if (input?.date_to) {
    const d = clampDate(input.date_to);
    if (!d) return { error: "date_to must be YYYY-MM-DD" };
    q = q.lte("ship_date", d);
  }

  const { data, error } = await q;
  if (error) return { error: error.message };

  const seenSkuIds = Array.from(new Set((data || []).map(r => r.sku_id).filter(Boolean)));
  let skuToStyle = new Map();
  let skuToCode  = new Map();
  if (seenSkuIds.length > 0 && (input?.group_by ?? "style") !== "customer") {
    const { data: masters } = await db
      .from("ip_item_master").select("id, sku_code, style_code")
      .in("id", seenSkuIds);
    for (const m of (masters || [])) {
      if (m.style_code) skuToStyle.set(m.id, m.style_code);
      if (m.sku_code)   skuToCode.set(m.id, m.sku_code);
    }
  }

  const groupBy = input?.group_by ?? "style";
  const groups = new Map();
  for (const r of (data || [])) {
    let key;
    switch (groupBy) {
      case "sku":      key = skuToCode.get(r.sku_id) || r.sku_id; break;
      case "customer": key = r.customer_name || r.customer_id || "(no customer)"; break;
      case "month":    key = monthKey(r.ship_date); break;
      case "style":
      default:         key = skuToStyle.get(r.sku_id) || skuToCode.get(r.sku_id) || "(unmatched)"; break;
    }
    if (!groups.has(key)) groups.set(key, { key, qty_open: 0, qty_ordered: 0, qty_shipped: 0, value: 0, row_count: 0 });
    const g = groups.get(key);
    g.qty_open    += Number(r.qty_open    || 0);
    g.qty_ordered += Number(r.qty_ordered || 0);
    g.qty_shipped += Number(r.qty_shipped || 0);
    g.value       += Number(r.qty_open || 0) * Number(r.unit_price || 0);
    g.row_count   += 1;
  }
  const out = Array.from(groups.values()).sort((a, b) => b.qty_open - a.qty_open).slice(0, QUERY_RESULT_LIMIT);
  return {
    groups: out,
    group_count: groups.size,
    row_count: (data || []).length,
    capped: (data || []).length >= QUERY_ROW_LIMIT,
    group_by: groupBy,
  };
}

async function tool_query_open_pos(db, input) {
  const skuIdsResolved = await resolveSkuIdsForStyleOrSku(db, input);
  if (skuIdsResolved?.error) return { error: skuIdsResolved.error };
  const skuIds = skuIdsResolved?.ids ?? null;
  if (skuIds && skuIds.length === 0) {
    return { groups: [], note: "No SKUs matched the supplied style_code/sku_code." };
  }

  let q = db
    .from("ip_open_purchase_orders")
    .select("sku_id, vendor_id, expected_date, qty_ordered, qty_received, qty_open, unit_cost")
    .limit(QUERY_ROW_LIMIT);
  if (skuIds) q = q.in("sku_id", skuIds);
  if (input?.date_from) {
    const d = clampDate(input.date_from);
    if (!d) return { error: "date_from must be YYYY-MM-DD" };
    q = q.gte("expected_date", d);
  }
  if (input?.date_to) {
    const d = clampDate(input.date_to);
    if (!d) return { error: "date_to must be YYYY-MM-DD" };
    q = q.lte("expected_date", d);
  }

  const { data, error } = await q;
  if (error) return { error: error.message };

  const seenSkuIds = Array.from(new Set((data || []).map(r => r.sku_id).filter(Boolean)));
  let skuToStyle = new Map();
  let skuToCode  = new Map();
  if (seenSkuIds.length > 0) {
    const { data: masters } = await db
      .from("ip_item_master").select("id, sku_code, style_code")
      .in("id", seenSkuIds);
    for (const m of (masters || [])) {
      if (m.style_code) skuToStyle.set(m.id, m.style_code);
      if (m.sku_code)   skuToCode.set(m.id, m.sku_code);
    }
  }

  const groupBy = input?.group_by ?? "style";
  const groups = new Map();
  for (const r of (data || [])) {
    let key;
    switch (groupBy) {
      case "sku":   key = skuToCode.get(r.sku_id) || r.sku_id; break;
      case "month": key = monthKey(r.expected_date); break;
      case "style":
      default:      key = skuToStyle.get(r.sku_id) || skuToCode.get(r.sku_id) || "(unmatched)"; break;
    }
    if (!groups.has(key)) groups.set(key, { key, qty_open: 0, qty_ordered: 0, qty_received: 0, cost: 0, row_count: 0 });
    const g = groups.get(key);
    g.qty_open    += Number(r.qty_open    || 0);
    g.qty_ordered += Number(r.qty_ordered || 0);
    g.qty_received+= Number(r.qty_received|| 0);
    g.cost        += Number(r.qty_open || 0) * Number(r.unit_cost || 0);
    g.row_count   += 1;
  }
  const out = Array.from(groups.values()).sort((a, b) => b.qty_open - a.qty_open).slice(0, QUERY_RESULT_LIMIT);
  return {
    groups: out,
    group_count: groups.size,
    row_count: (data || []).length,
    capped: (data || []).length >= QUERY_ROW_LIMIT,
    group_by: groupBy,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Generic cross-app tools — discovery + parameterised query
// ─────────────────────────────────────────────────────────────────────

async function tool_list_domains(db) {
  const merged = await getMergedDomains(db);
  return {
    domains: Object.values(merged).map(d => ({
      domain: d.domain,
      description: d.description,
      table_count: Object.keys(d.tables).length,
    })),
  };
}

async function tool_list_tables(db, input) {
  const merged = await getMergedDomains(db);
  const domain = merged[input?.domain];
  if (!domain) return { error: `Unknown domain: ${input?.domain}. Valid: ${Object.keys(merged).join(", ")}` };
  return {
    domain: domain.domain,
    tables: Object.entries(domain.tables).map(([name, t]) => ({
      table: name,
      description: t.description,
      column_count: Object.keys(publicColumns(t)).length,
    })),
  };
}

async function tool_describe_table(db, input) {
  const tableName = String(input?.table || "").trim();
  if (!tableName) return { error: "table required" };
  const found = await mergedLookupTable(db, input?.domain, tableName);
  if (!found) {
    if (input?.domain) return { error: `Table '${tableName}' not in domain '${input.domain}' (or domain unknown).` };
    return { error: `Unknown table: ${tableName}. Use list_tables(domain) to discover.` };
  }
  const cols = publicColumns(found.table);
  return {
    domain: found.domainName,
    table: tableName,
    description: found.table.description,
    columns: Object.entries(cols).map(([name, meta]) => ({
      name,
      type: meta.type,
      filterable: !!meta.filterable,
      groupable:  !!meta.groupable,
      aggregatable: !!meta.aggregatable,
      date: !!meta.date,
    })),
  };
}

async function tool_query_table(db, input) {
  const tableName = String(input?.table || "").trim();
  if (!tableName) return { error: "table required" };
  const found = await mergedLookupTable(db, input?.domain, tableName);
  if (!found) {
    if (input?.domain) return { error: `Table '${tableName}' not in domain '${input.domain}'.` };
    return { error: `Unknown table: ${tableName}.` };
  }
  const table   = found.table;
  const colMeta = publicColumns(table);

  const groupBy = Array.isArray(input?.group_by) ? input.group_by.slice(0, 3) : [];
  for (const g of groupBy) {
    if (!colMeta[g]) return { error: `group_by column '${g}' not readable on '${tableName}'.` };
    if (!colMeta[g].groupable) return { error: `Column '${g}' is not groupable.` };
  }

  const aggs = Array.isArray(input?.aggregations) ? input.aggregations : [];
  for (const a of aggs) {
    if (!ALLOWED_AGGS.includes(a.fn)) return { error: `Unknown aggregation: ${a.fn}` };
    if (a.fn !== "count") {
      if (!a.col) return { error: `aggregation ${a.fn} requires a col.` };
      if (!colMeta[a.col]) return { error: `agg col '${a.col}' not readable on '${tableName}'.` };
      if (!colMeta[a.col].aggregatable) return { error: `Column '${a.col}' is not aggregatable.` };
    }
  }

  // Build column selector. We only fetch what we need: group_by cols +
  // agg target cols. PostgREST doesn't do SQL GROUP BY without RPC, so
  // we pull the rows (capped) and aggregate in-memory.
  const selectCols = new Set();
  for (const g of groupBy) selectCols.add(g);
  for (const a of aggs) if (a.col) selectCols.add(a.col);
  if (selectCols.size === 0) {
    for (const c of Object.keys(colMeta).slice(0, 12)) selectCols.add(c);
  }
  const selectStr = Array.from(selectCols).join(", ");

  let q = db.from(tableName).select(selectStr).limit(QUERY_ROW_LIMIT);

  const filters = Array.isArray(input?.filters) ? input.filters : [];
  if (filters.length > 20) return { error: "Too many filters (cap 20)." };
  for (const f of filters) {
    const r = applyFilter(q, table, f);
    if (!r.ok) return { error: r.error };
    q = r.q;
  }

  if (input?.date_range && input.date_range.col) {
    const dr = input.date_range;
    const meta = colMeta[dr.col];
    if (!meta) return { error: `date_range.col '${dr.col}' not readable.` };
    if (!meta.date) return { error: `Column '${dr.col}' is not a date column.` };
    if (dr.from) {
      const d = clampDate(dr.from);
      if (!d) return { error: "date_range.from must be YYYY-MM-DD." };
      q = q.gte(dr.col, d);
    }
    if (dr.to) {
      const d = clampDate(dr.to);
      if (!d) return { error: "date_range.to must be YYYY-MM-DD." };
      q = q.lte(dr.col, d);
    }
  }

  const { data, error } = await q;
  if (error) return { error: error.message };
  const rows = data || [];

  if (groupBy.length === 0 && aggs.length === 0) {
    const limit = Math.min(Math.max(1, Number(input?.limit) || 50), 200);
    return {
      mode: "rows",
      row_count: rows.length,
      capped: rows.length >= QUERY_ROW_LIMIT,
      rows: rows.slice(0, limit),
    };
  }

  const groups = new Map();
  for (const r of rows) {
    const key = groupBy.map(g => String(r[g] ?? "(null)")).join(" | ");
    if (!groups.has(key)) {
      const seed = { _group: {} };
      for (const g of groupBy) seed._group[g] = r[g] ?? null;
      groups.set(key, { ...seed, _rows: [] });
    }
    groups.get(key)._rows.push(r);
  }

  const outRows = [];
  for (const g of groups.values()) {
    const out = { ...g._group };
    for (const a of aggs) {
      const alias = a.as || (a.fn === "count" ? "count" : `${a.fn}_${a.col}`);
      if (a.fn === "count") {
        out[alias] = g._rows.length;
        continue;
      }
      const vals = g._rows.map(r => Number(r[a.col] || 0));
      switch (a.fn) {
        case "sum": out[alias] = vals.reduce((s, v) => s + v, 0); break;
        case "avg": out[alias] = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0; break;
        case "min": out[alias] = vals.length ? Math.min(...vals) : null; break;
        case "max": out[alias] = vals.length ? Math.max(...vals) : null; break;
      }
    }
    outRows.push(out);
  }

  if (input?.order_by?.col) {
    const c = input.order_by.col;
    const dir = input.order_by.dir === "asc" ? 1 : -1;
    outRows.sort((a, b) => {
      const av = a[c]; const bv = b[c];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  } else if (aggs.length > 0) {
    const a0 = aggs[0];
    const alias = a0.as || (a0.fn === "count" ? "count" : `${a0.fn}_${a0.col}`);
    outRows.sort((a, b) => (Number(b[alias]) || 0) - (Number(a[alias]) || 0));
  }

  const limit = Math.min(Math.max(1, Number(input?.limit) || 50), 200);
  return {
    mode: "groups",
    domain: found.domainName,
    table: tableName,
    group_count: outRows.length,
    row_count: rows.length,
    capped: rows.length >= QUERY_ROW_LIMIT,
    group_by: groupBy,
    aggregations: aggs,
    groups: outRows.slice(0, limit),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Dispatcher map — consumed by the handler + streaming loop
// ─────────────────────────────────────────────────────────────────────
// Entity-card tools (style_card / customer_card) live in
// ./executors-cards.js — see that module for implementation. Kept
// separate per architecture invariant #2 (executors.js stays under 700
// lines).

export const TOOL_EXECUTORS = {
  find_customer:    tool_find_customer,
  find_style:       tool_find_style,
  query_shipments:  tool_query_shipments,
  query_open_sos:   tool_query_open_sos,
  query_open_pos:   tool_query_open_pos,
  list_domains:     async (db) => tool_list_domains(db),
  list_tables:      async (db, input) => tool_list_tables(db, input),
  describe_table:   async (db, input) => tool_describe_table(db, input),
  query_table:      tool_query_table,
  style_card:       tool_style_card,
  customer_card:    tool_customer_card,
  query_margin:     tool_query_margin,
  lookup_user_facts: tool_lookup_user_facts,
  start_workflow:    tool_start_workflow,
  // Documentation search — reads the bundled user-guide snapshot, not the DB.
  search_user_guide: async (_db, input) => searchUserGuide(input || {}),
  // P28-2 — the caller's Today aggregate (assistant-first program).
  get_today:         tool_get_today,
  // P28-4 — draft-action preview + confirm-token mint (looped, never writes).
  run_action:        tool_run_action,
};
