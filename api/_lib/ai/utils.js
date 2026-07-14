// Pure helpers shared by the handler, executors, and streaming path.
// Nothing here touches the network or Supabase — kept side-effect-free
// so unit tests can import directly.

import {
  MAX_HISTORY_TURNS,
  MAX_DISTINCT_VALS,
  MAX_SAMPLE_ROWS,
} from "./constants.js";

// Uppercase + collapse whitespace. Used by find_customer fuzzy match.
export function canonName(s) {
  return String(s || "").trim().toUpperCase().replace(/\s+/g, " ");
}

export function clampString(s, max) {
  return String(s || "").slice(0, max);
}

// ISO YYYY-MM-DD only — reject anything else so callers can't smuggle
// PostgREST operators into the parameter.
export function clampDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// "2026-03" — used by query_* tools' group_by:"month".
export function monthKey(dateStr) {
  if (!dateStr) return "unknown";
  return String(dateStr).slice(0, 7);
}

export function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .slice(-MAX_HISTORY_TURNS)
    .filter(h => h && (h.role === "user" || h.role === "assistant") && typeof h.text === "string" && h.text.length > 0)
    .map(h => ({ role: h.role, content: h.text.slice(0, 2000) }));
}

// Sanitise the array of follow-up questions Claude emits via
// suggest_followups. Trims whitespace, drops empty + over-long
// (> 70 chars) entries, caps at 3. Returns null when nothing
// useful survives so the caller can fall through cleanly.
export function sanitizeFollowups(arr) {
  if (!Array.isArray(arr)) return null;
  const cleaned = arr
    .map(q => String(q ?? "").trim())
    .filter(q => q.length > 0 && q.length <= 70)
    .slice(0, 3);
  return cleaned.length > 0 ? cleaned : null;
}

export function clampDistinct(arr) {
  if (!Array.isArray(arr)) return [];
  const filtered = arr.filter(v => typeof v === "string" && v.length > 0);
  if (filtered.length <= MAX_DISTINCT_VALS) return filtered;
  return [...filtered.slice(0, MAX_DISTINCT_VALS), `…(+${filtered.length - MAX_DISTINCT_VALS} more)`];
}

// Build the user-message context block that goes alongside every
// question. Includes today's date (so Claude can resolve "last
// quarter") + active filters + totals + distinct values + sample rows.
export function buildGridContextBlock(ctx) {
  const distinct = ctx.distinct || {};
  const totals   = ctx.totals   || {};
  const filters  = ctx.active_filters || {};
  const sample   = Array.isArray(ctx.sample_rows) ? ctx.sample_rows.slice(0, MAX_SAMPLE_ROWS) : [];
  const lines = [];
  lines.push(`Today's date: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`Visible rows: ${ctx.row_count ?? "unknown"}`);
  lines.push(`Columns: ${Array.isArray(ctx.columns) ? ctx.columns.join(", ") : "(unknown)"}`);
  lines.push("");
  lines.push("Active filters:");
  lines.push(JSON.stringify(filters, null, 2));
  if (ctx.sort) {
    lines.push("");
    lines.push(`Sort: ${ctx.sort.col} ${ctx.sort.dir}`);
  }
  lines.push("");
  lines.push("Totals (across the visible rows):");
  lines.push(JSON.stringify(totals, null, 2));
  lines.push("");
  lines.push("Distinct filterable values:");
  lines.push(JSON.stringify({
    categories:     clampDistinct(distinct.categories),
    sub_categories: clampDistinct(distinct.sub_categories),
    styles:         clampDistinct(distinct.styles),
    genders:        clampDistinct(distinct.genders),
    stores:         clampDistinct(distinct.stores),
  }, null, 2));
  if (sample.length > 0) {
    lines.push("");
    lines.push(`Sample rows (first ${sample.length}):`);
    lines.push(JSON.stringify(sample, null, 2));
  }
  return lines.join("\n");
}

// "5m" / "42m" / "1h" / "23h" — short relative label for cache age.
export function formatCacheAge(seconds) {
  if (seconds < 60)   return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

// Compact one-liner per executed tool — shown in the trace block under
// the AI reply so operators can see what was looked up.
export function summarizeToolResult(name, result) {
  if (!result || typeof result !== "object") return `${name}: ok`;
  if (result.error) return `${name}: error — ${String(result.error).slice(0, 120)}`;
  if (name === "find_customer")  return `find_customer: ${result.count ?? 0} match(es)`;
  if (name === "find_style")     return `find_style: ${result.count ?? 0} style(s)`;
  if (name === "list_domains")   return `list_domains: ${result.domains?.length ?? 0} domains`;
  if (name === "list_tables")    return `list_tables(${result.domain}): ${result.tables?.length ?? 0} tables`;
  if (name === "describe_table") return `describe_table(${result.table}): ${result.columns?.length ?? 0} cols`;
  if (name === "query_table") {
    return `query_table(${result.table ?? "?"}): ${result.mode === "rows" ? `${result.rows?.length ?? 0} rows` : `${result.group_count ?? 0} group(s)`} from ${result.row_count ?? 0}${result.capped ? " (CAPPED)" : ""}`;
  }
  if (name.startsWith("query_")) {
    const t = result.totals;
    const sums = t ? ` totals=qty:${t.qty?.toFixed?.(0) ?? "?"} amt:${t.net_amount?.toFixed?.(0) ?? "?"}` : "";
    return `${name}: ${result.group_count ?? 0} group(s) from ${result.row_count ?? 0} rows${result.capped ? " (CAPPED)" : ""}${sums}`;
  }
  return `${name}: ok`;
}

// One-shot SSE event writer.
export function sseWrite(res, event, data) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ── P28-3: screen-context block (companion mode) ────────────────────────
//
// Sanitise + render the client's `screen_context` body field into the
// prompt block the model sees. Hard clamps everywhere — this is client
// input travelling into a prompt.

const SCREEN_KEY_MAX = 40;
const SCREEN_VAL_MAX = 120;
const SCREEN_PARAMS_MAX = 8;

export function sanitizeScreenContext(raw) {
  if (!raw || typeof raw !== "object") return null;
  const panelKey = typeof raw.panel_key === "string" ? raw.panel_key.trim().slice(0, SCREEN_KEY_MAX) : "";
  if (!panelKey || !/^[a-z0-9_]+$/i.test(panelKey)) return null;
  const out = { panel_key: panelKey };
  if (typeof raw.label === "string" && raw.label.trim()) out.label = raw.label.trim().slice(0, SCREEN_VAL_MAX);
  if (typeof raw.detail === "string" && raw.detail.trim()) out.detail = raw.detail.trim().slice(0, 300);
  if (raw.params && typeof raw.params === "object") {
    const params = {};
    for (const [k, v] of Object.entries(raw.params).slice(0, SCREEN_PARAMS_MAX)) {
      const key = String(k).trim().slice(0, SCREEN_KEY_MAX);
      const val = String(v ?? "").trim().slice(0, SCREEN_VAL_MAX);
      if (key && val) params[key] = val;
    }
    if (Object.keys(params).length > 0) out.params = params;
  }
  return out;
}

export function buildScreenContextBlock(screen) {
  const sc = sanitizeScreenContext(screen);
  if (!sc) return "";
  const lines = [`Panel: ${sc.label ? `${sc.label} (${sc.panel_key})` : sc.panel_key}`];
  if (sc.params) {
    for (const [k, v] of Object.entries(sc.params)) lines.push(`${k}: ${v}`);
  }
  if (sc.detail) lines.push(sc.detail);
  return `\n\n## Current Tangerine screen (what the operator is looking at)\n${lines.join("\n")}`;
}
