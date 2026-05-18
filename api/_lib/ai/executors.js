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

  let q = db
    .from("ip_sales_history_wholesale")
    .select("sku_id, customer_id, txn_date, txn_type, qty, net_amount")
    .gte("txn_date", date_from)
    .lte("txn_date", date_to)
    .limit(QUERY_ROW_LIMIT);
  if (input?.customer_id) q = q.eq("customer_id", input.customer_id);
  if (input?.txn_type)    q = q.eq("txn_type",    input.txn_type);
  if (skuIds)             q = q.in("sku_id", skuIds);

  const { data, error } = await q;
  if (error) return { error: error.message };

  const seenSkuIds = Array.from(new Set((data || []).map(r => r.sku_id).filter(Boolean)));
  let skuToStyle = new Map();
  let skuToCode  = new Map();
  if (seenSkuIds.length > 0 && (input?.group_by ?? "style") !== "customer") {
    const { data: masters } = await db
      .from("ip_item_master")
      .select("id, sku_code, style_code")
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
      case "customer": key = r.customer_id || "(no customer)";    break;
      case "month":    key = monthKey(r.txn_date);                break;
      case "style":
      default:         key = skuToStyle.get(r.sku_id) || skuToCode.get(r.sku_id) || "(unmatched)"; break;
    }
    if (!groups.has(key)) groups.set(key, { key, qty: 0, net_amount: 0, row_count: 0 });
    const g = groups.get(key);
    g.qty        += Number(r.qty || 0);
    g.net_amount += Number(r.net_amount || 0);
    g.row_count  += 1;
  }
  const out = Array.from(groups.values()).sort((a, b) => b.qty - a.qty).slice(0, QUERY_RESULT_LIMIT);
  const totalQty = out.reduce((s, g) => s + g.qty, 0);
  const totalAmt = out.reduce((s, g) => s + g.net_amount, 0);
  return {
    groups: out,
    group_count: groups.size,
    row_count: (data || []).length,
    capped: (data || []).length >= QUERY_ROW_LIMIT,
    totals: { qty: totalQty, net_amount: totalAmt },
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

  let q = db
    .from("ip_open_sales_orders")
    .select("sku_id, customer_id, customer_name, ship_date, qty_ordered, qty_shipped, qty_open, unit_price")
    .limit(QUERY_ROW_LIMIT);
  if (input?.customer_id) q = q.eq("customer_id", input.customer_id);
  if (skuIds)             q = q.in("sku_id", skuIds);
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
// Entity cards — single-call pre-aggregated snapshots
// ─────────────────────────────────────────────────────────────────────
//
// Tier 1D of the Ask AI improvement plan. When the operator names a
// single style or customer and wants a quick read, these tools deliver
// the whole context block in one round trip instead of the
// find_customer → find_style → describe_table → query_shipments →
// query_open_sos dance.
//
// Cards are read-only snapshots — they don't mutate the grid or apply
// filters. Use them for "how is X doing?" / "give me a quick view on
// Y" / "snapshot of Z" style questions where the operator wants
// orientation, not a specific number.

// Compute T3 window (trailing 3 months from today) + LY window (T3
// shifted back 12 months). Used by both card tools.
function defaultCardWindows() {
  const today = new Date();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const t3End = iso(today);
  const t3Start = (() => { const d = new Date(today); d.setMonth(d.getMonth() - 3); return iso(d); })();
  const lyEnd = (() => { const d = new Date(today); d.setFullYear(d.getFullYear() - 1); return iso(d); })();
  const lyStart = (() => { const d = new Date(today); d.setMonth(d.getMonth() - 15); return iso(d); })();
  return { t3Start, t3End, lyStart, lyEnd };
}

// Growth share per ROF convention: (current − prior) / current. Returns
// a fraction (0.687 for 68.7%). Edge cases: current<=0 → null (formula
// breaks); prior<=0 with current>0 → 1 (entire current is incremental).
function growthShare(current, prior) {
  if (current <= 0) return null;
  if (prior <= 0) return 1;
  return (current - prior) / current;
}

// Aggregate shipments for a set of sku_ids over a date window.
// Returns { qty, revenue, by_customer: Map<customer_id, {qty, revenue}> }.
async function aggregateShipmentsForSkus(db, skuIds, dateStart, dateEnd) {
  if (!skuIds || skuIds.length === 0) return { qty: 0, revenue: 0, byCustomer: new Map() };
  // Bucket sku_ids into batches of 100 to stay under PostgREST URL limits.
  // For card use the ID list rarely exceeds a few hundred (one style's
  // variants), but be defensive.
  const byCustomer = new Map();
  let totalQty = 0;
  let totalRev = 0;
  for (let i = 0; i < skuIds.length; i += 100) {
    const batch = skuIds.slice(i, i + 100);
    const { data, error } = await db
      .from("ip_sales_history_wholesale")
      .select("customer_id, qty, net_amount")
      .gte("txn_date", dateStart)
      .lte("txn_date", dateEnd)
      .in("sku_id", batch)
      .limit(QUERY_ROW_LIMIT);
    if (error) return { error: error.message, qty: 0, revenue: 0, byCustomer };
    for (const r of (data || [])) {
      const qty = Number(r.qty || 0);
      const rev = Number(r.net_amount || 0);
      totalQty += qty;
      totalRev += rev;
      if (!r.customer_id) continue;
      if (!byCustomer.has(r.customer_id)) byCustomer.set(r.customer_id, { qty: 0, revenue: 0 });
      const c = byCustomer.get(r.customer_id);
      c.qty += qty;
      c.revenue += rev;
    }
  }
  return { qty: totalQty, revenue: totalRev, byCustomer };
}

// Aggregate shipments for a set of customer_ids over a date window.
// Returns { qty, revenue, bySku: Map<sku_id, {qty, revenue}> }.
async function aggregateShipmentsForCustomers(db, customerIds, dateStart, dateEnd) {
  if (!customerIds || customerIds.length === 0) return { qty: 0, revenue: 0, bySku: new Map() };
  const bySku = new Map();
  let totalQty = 0;
  let totalRev = 0;
  for (let i = 0; i < customerIds.length; i += 100) {
    const batch = customerIds.slice(i, i + 100);
    const { data, error } = await db
      .from("ip_sales_history_wholesale")
      .select("sku_id, qty, net_amount")
      .gte("txn_date", dateStart)
      .lte("txn_date", dateEnd)
      .in("customer_id", batch)
      .limit(QUERY_ROW_LIMIT);
    if (error) return { error: error.message, qty: 0, revenue: 0, bySku };
    for (const r of (data || [])) {
      const qty = Number(r.qty || 0);
      const rev = Number(r.net_amount || 0);
      totalQty += qty;
      totalRev += rev;
      if (!r.sku_id) continue;
      if (!bySku.has(r.sku_id)) bySku.set(r.sku_id, { qty: 0, revenue: 0 });
      const s = bySku.get(r.sku_id);
      s.qty += qty;
      s.revenue += rev;
    }
  }
  return { qty: totalQty, revenue: totalRev, bySku };
}

// Per-style snapshot card. One round trip from Claude's perspective,
// 5-7 sub-queries server-side. Returns:
//   { style, variants, inventory, sales (t3 + ly + growth), top_customers }
async function tool_style_card(db, input) {
  const style_code = clampString(input?.style_code, 50).trim();
  if (!style_code) return { error: "style_code required" };

  // 1. Master rows under this style (variant count + pack_size).
  const { data: masters, error: mastersErr } = await db
    .from("ip_item_master")
    .select("id, sku_code, style_code, description, color, size, pack_size, active, attributes")
    .eq("style_code", style_code)
    .limit(500);
  if (mastersErr) return { error: mastersErr.message };
  if (!masters || masters.length === 0) {
    return { error: `No master rows found for style_code='${style_code}'.` };
  }
  const skuIds = masters.map(m => m.id);
  const variants = masters.length;
  const distinctColors = Array.from(new Set(masters.map(m => m.color).filter(Boolean))).slice(0, 20);
  const packSize = Math.max(1, ...masters.map(m => m.pack_size || 1));
  const styleLevelRow = masters.find(m => m.sku_code === m.style_code) || masters[0];
  const category = styleLevelRow?.attributes?.group_name || null;
  const subCategory = styleLevelRow?.attributes?.category_name || null;
  const sampleDescription = styleLevelRow?.description || null;

  // 2. Sales windows.
  const { t3Start, t3End, lyStart, lyEnd } = defaultCardWindows();

  // 3. Parallel sub-queries: T3 shipments, LY shipments, open SOs, open POs.
  const [t3Agg, lyAgg, openSosResult, openPosResult] = await Promise.all([
    aggregateShipmentsForSkus(db, skuIds, t3Start, t3End),
    aggregateShipmentsForSkus(db, skuIds, lyStart, lyEnd),
    db.from("ip_open_sales_orders").select("qty_open, unit_price").in("sku_id", skuIds.slice(0, 100)).limit(QUERY_ROW_LIMIT),
    db.from("ip_open_purchase_orders").select("qty_open, unit_cost").in("sku_id", skuIds.slice(0, 100)).limit(QUERY_ROW_LIMIT),
  ]);
  if (t3Agg.error) return { error: `t3 shipments: ${t3Agg.error}` };
  if (lyAgg.error) return { error: `ly shipments: ${lyAgg.error}` };

  // 4. Resolve top T3 customers by revenue (limit 5).
  const topCustomerEntries = Array.from(t3Agg.byCustomer.entries())
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 5);
  const topCustomerIds = topCustomerEntries.map(([id]) => id);
  let customerNameById = new Map();
  if (topCustomerIds.length > 0) {
    const { data: custs } = await db
      .from("ip_customer_master")
      .select("id, name")
      .in("id", topCustomerIds);
    for (const c of (custs || [])) {
      if (c.id && c.name) customerNameById.set(c.id, c.name);
    }
  }
  const topCustomers = topCustomerEntries.map(([id, agg]) => ({
    customer_id: id,
    name: customerNameById.get(id) || "(unknown)",
    t3_revenue: agg.revenue,
    t3_qty: agg.qty,
  }));

  // 5. Open commitments (rough $ totals; capped at 100 sku_ids batch above).
  const openSoTotal = (openSosResult.data || []).reduce(
    (s, r) => s + Number(r.qty_open || 0) * Number(r.unit_price || 0), 0,
  );
  const openPoTotal = (openPosResult.data || []).reduce(
    (s, r) => s + Number(r.qty_open || 0) * Number(r.unit_cost || 0), 0,
  );

  return {
    style: {
      style_code,
      description: sampleDescription,
      category,
      sub_category: subCategory,
      pack_size: packSize,
      is_prepack: packSize > 1,
      variant_count: variants,
      distinct_colors: distinctColors,
    },
    sales: {
      t3_window: { start: t3Start, end: t3End },
      ly_window: { start: lyStart, end: lyEnd },
      t3: { qty: t3Agg.qty, revenue: t3Agg.revenue },
      ly: { qty: lyAgg.qty, revenue: lyAgg.revenue },
      growth_qty:     growthShare(t3Agg.qty,     lyAgg.qty),
      growth_revenue: growthShare(t3Agg.revenue, lyAgg.revenue),
      top_customers_t3: topCustomers,
    },
    open_commitments: {
      open_sales_orders_usd: openSoTotal,
      open_purchase_orders_usd: openPoTotal,
    },
    notes: [
      packSize > 1 ? `Sales qty above is at Xoro's recorded grain — may be pack-count for this prepack (pack_size=${packSize}). Multiply by ${packSize} for unit-grain.` : null,
    ].filter(Boolean),
  };
}

// Per-customer snapshot card. Accepts either customer_id (uuid) or
// customer_name (free-text, resolved via find_customer's logic).
async function tool_customer_card(db, input) {
  const customerName = clampString(input?.customer_name, 100).trim();
  const customerIdInput = clampString(input?.customer_id, 64).trim();
  if (!customerName && !customerIdInput) {
    return { error: "customer_id or customer_name required" };
  }

  // 1. Resolve customer IDs. Xoro name drift means one logical customer
  // can have multiple rows.
  let customerIds = [];
  let resolvedRows = [];
  if (customerIdInput) {
    const { data, error } = await db
      .from("ip_customer_master")
      .select("id, name, customer_code")
      .eq("id", customerIdInput);
    if (error) return { error: error.message };
    resolvedRows = data || [];
    customerIds = resolvedRows.map(r => r.id);
  } else {
    const firstWord = customerName.split(/\s+/)[0] || customerName;
    const target = canonName(customerName);
    const { data, error } = await db
      .from("ip_customer_master")
      .select("id, name, customer_code")
      .ilike("name", `${firstWord}%`)
      .limit(FIND_CUSTOMER_LIMIT);
    if (error) return { error: error.message };
    resolvedRows = (data || []).filter(r => {
      const c = canonName(r.name || "");
      return c === target || c.startsWith(target) || target.startsWith(c);
    });
    customerIds = resolvedRows.map(r => r.id);
  }
  if (customerIds.length === 0) {
    return { error: `No customer match for '${customerName || customerIdInput}'.` };
  }

  // 2. Sales windows.
  const { t3Start, t3End, lyStart, lyEnd } = defaultCardWindows();

  // 3. Parallel sub-queries: T3 + LY shipments + open SOs (open POs
  // aren't customer-scoped, skip).
  const [t3Agg, lyAgg, openSosResult] = await Promise.all([
    aggregateShipmentsForCustomers(db, customerIds, t3Start, t3End),
    aggregateShipmentsForCustomers(db, customerIds, lyStart, lyEnd),
    db.from("ip_open_sales_orders").select("qty_open, unit_price, ship_date").in("customer_id", customerIds).limit(QUERY_ROW_LIMIT),
  ]);
  if (t3Agg.error) return { error: `t3 shipments: ${t3Agg.error}` };
  if (lyAgg.error) return { error: `ly shipments: ${lyAgg.error}` };

  // 4. Resolve top T3 styles by revenue (limit 5).
  const topSkuEntries = Array.from(t3Agg.bySku.entries())
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 20);
  const topSkuIds = topSkuEntries.map(([id]) => id);
  let skuStyleById = new Map();
  if (topSkuIds.length > 0) {
    const { data: masters } = await db
      .from("ip_item_master")
      .select("id, style_code, description")
      .in("id", topSkuIds);
    for (const m of (masters || [])) {
      if (m.id) skuStyleById.set(m.id, { style_code: m.style_code, description: m.description });
    }
  }
  // Aggregate by style_code (since one style has many sku_ids).
  const styleRevenue = new Map();
  for (const [skuId, agg] of topSkuEntries) {
    const meta = skuStyleById.get(skuId);
    const key = meta?.style_code || "(unmatched)";
    if (!styleRevenue.has(key)) styleRevenue.set(key, { qty: 0, revenue: 0, description: meta?.description || null });
    const s = styleRevenue.get(key);
    s.qty += agg.qty;
    s.revenue += agg.revenue;
  }
  const topStyles = Array.from(styleRevenue.entries())
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 5)
    .map(([style_code, v]) => ({ style_code, description: v.description, t3_revenue: v.revenue, t3_qty: v.qty }));

  // 5. Open SOs total $.
  const openSoTotal = (openSosResult.data || []).reduce(
    (s, r) => s + Number(r.qty_open || 0) * Number(r.unit_price || 0), 0,
  );

  return {
    customer: {
      ids: customerIds,
      canonical_names: resolvedRows.map(r => r.name).filter(Boolean),
      customer_codes: resolvedRows.map(r => r.customer_code).filter(Boolean),
      alias_count: customerIds.length,
    },
    sales: {
      t3_window: { start: t3Start, end: t3End },
      ly_window: { start: lyStart, end: lyEnd },
      t3: { qty: t3Agg.qty, revenue: t3Agg.revenue },
      ly: { qty: lyAgg.qty, revenue: lyAgg.revenue },
      growth_qty:     growthShare(t3Agg.qty,     lyAgg.qty),
      growth_revenue: growthShare(t3Agg.revenue, lyAgg.revenue),
      top_styles_t3: topStyles,
    },
    open_commitments: {
      open_sales_orders_usd: openSoTotal,
    },
    notes: customerIds.length > 1 ? [`Resolved ${customerIds.length} ip_customer_master rows under this name — typical of Xoro spelling drift.`] : [],
  };
}

// ─────────────────────────────────────────────────────────────────────

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
};
