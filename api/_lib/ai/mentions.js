// Autocomplete-shaped lookups for the Ask AI @mention dropdown
// (PR 2/4 vanilla-Claude UX).
//
// The existing tool_find_customer / tool_find_style executors are
// tuned for the AI's tool-use loop (return a "matches" / "styles"
// shape with sample SKUs etc.). The mention dropdown wants a
// uniform `{ id, label, sublabel }[]` shape sized for a 5-row UI list
// — short, fast, and the same shape for both entity kinds so the
// dropdown component doesn't have to branch.
//
// Privacy + safety: read-only against ip_customer_master /
// ip_item_master, same tables the loop-side executors already touch.
// No PII surfaces here (customer_code + name are both public-facing).

import { canonName } from "./utils.js";

// Mention dropdown is intentionally small — operators see 5-8 results
// and pick the right one. Larger lists make the autocomplete slower
// to scan than just typing the full name.
const MENTION_LIMIT = 8;

/**
 * Pure ranking helper: prefer exact-canonical matches > startsWith
 * either direction > plain inclusion. Used to sort raw rows from
 * `ip_customer_master` queries. Exposed for unit testing.
 */
export function scoreCustomerRow(row, query) {
  const target = canonName(query);
  const c = canonName(row?.name || "");
  if (!c || !target) return 0;
  if (c === target) return 3;
  if (c.startsWith(target) || target.startsWith(c)) return 2;
  if (c.includes(target)) return 1;
  return 0;
}

/**
 * Look up customers for the @mention dropdown. Returns a small list
 * of `{ id, label, sublabel }` rows sorted by relevance.
 */
export async function suggestCustomers(db, query) {
  const q = String(query || "").trim();
  if (!q) return { items: [] };
  const firstWord = q.split(/\s+/)[0] || q;
  // Cast a wide net via ilike on the first word — the most reliable
  // prefix-match strategy given Xoro name drift ("Ross", "ROSS",
  // "Ross Procurement, Inc." etc.). Server-side rank narrows to the
  // best MENTION_LIMIT.
  const { data, error } = await db
    .from("ip_customer_master")
    .select("id, name, customer_code")
    .ilike("name", `${firstWord}%`)
    .limit(MENTION_LIMIT * 4);
  if (error) return { error: error.message, items: [] };

  const ranked = (data || [])
    .map(r => ({ ...r, _score: scoreCustomerRow(r, q) }))
    .sort((a, b) => b._score - a._score || String(a.name || "").localeCompare(String(b.name || "")))
    .slice(0, MENTION_LIMIT)
    .map(r => ({
      id: r.id,
      label: r.name,
      sublabel: r.customer_code ? `Customer · ${r.customer_code}` : "Customer",
    }));
  return { items: ranked };
}

/**
 * Look up styles for the @mention dropdown. De-duplicates by
 * `style_code` and returns the highest-confidence style code per
 * substring match.
 */
export async function suggestStyles(db, query) {
  const q = String(query || "").trim();
  if (!q) return { items: [] };
  const enc = `%${q.replace(/[%_]/g, "\\$&")}%`;
  const { data, error } = await db
    .from("ip_item_master")
    .select("sku_code, style_code, description, active")
    .or(`sku_code.ilike.${enc},style_code.ilike.${enc},description.ilike.${enc}`)
    .eq("active", true)
    .limit(MENTION_LIMIT * 6);
  if (error) return { error: error.message, items: [] };

  // Collapse to one row per style_code (preferred) or sku_code (fallback).
  // Score: exact style_code match wins, then prefix, then includes.
  const byKey = new Map();
  const target = String(q).toLowerCase();
  for (const r of (data || [])) {
    const key = r.style_code || r.sku_code;
    if (!key) continue;
    const lowerKey = key.toLowerCase();
    const score = lowerKey === target ? 3
                : lowerKey.startsWith(target) ? 2
                : lowerKey.includes(target) ? 1
                : 0;
    const existing = byKey.get(key);
    if (!existing || score > existing._score) {
      byKey.set(key, {
        id: key,
        label: key,
        sublabel: r.description ? `Style · ${r.description}` : "Style",
        _score: score,
      });
    }
  }
  const items = Array.from(byKey.values())
    .sort((a, b) => b._score - a._score || a.label.localeCompare(b.label))
    .slice(0, MENTION_LIMIT)
    .map(({ _score, ...rest }) => rest);  // strip internal _score
  return { items };
}

/**
 * Combined dispatcher used by the HTTP handler.
 */
export async function suggestMentions(db, { query, type }) {
  const t = String(type || "").toLowerCase();
  if (t === "customer") return suggestCustomers(db, query);
  if (t === "style")    return suggestStyles(db, query);
  return { error: `unknown type '${type}'; use customer or style`, items: [] };
}
