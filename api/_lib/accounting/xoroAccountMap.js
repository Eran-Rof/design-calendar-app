// api/_lib/accounting/xoroAccountMap.js
//
// Deterministic Xoro-GL-account-name → ROF gl_accounts resolution.
//
// CEO directive (#xoro-account-truth, 2026-07-11, NON-NEG): Xoro's GL is the
// 100% source of truth for bill classifications; nothing posts from
// name/pattern heuristics. Xoro's bill feed carries the account as a path
// string like:
//
//   '5006 General and Administrative:Logistics Warehouse Expense'
//   'Shipping Expense'
//   '5005 Freight Expenses:Freight In Expense'
//
// i.e. optional parent segments separated by ':', each segment optionally
// prefixed with Xoro's own numeric code. Xoro's codes do NOT match the
// Tangerine 449-account ROF COA (Xoro '5006' is a G&A parent; Tangerine 5006
// is something else entirely) — so codes from the path are only trusted when
// the code AND the name both match the same ROF account.
//
// Resolution is EXACT (case-insensitive) on the path's leaf segment — no
// fuzzy matching, per the directive. Order:
//   1. XORO_TO_ROF_CODE explicit mapping (leaf, lowercased) — the curated
//      dictionary for Xoro names that have no same-named ROF account.
//   2. leaf 'CODE Name' where CODE and Name both match one ROF account.
//   3. leaf name (code prefix stripped) equals exactly one eligible ROF
//      account name (case-insensitive; ambiguous names never resolve).
//   4. whole leaf (code prefix kept) equals exactly one ROF account name.
// Eligible accounts: this entity, is_postable, not is_control, active.
// Anything unresolved stays name-only and feeds the unmatched-name mapping
// report (scripts/reclass-8007.mjs xoro-verify) for the controller/CEO.

// Curated Xoro-name → ROF-code map. Keys are LOWERCASED leaf names (after
// ':'-split; both the code-stripped and raw form are looked up). Add entries
// only from observed Xoro names (the xoro-verify unmatched report), never
// speculatively.
export const XORO_TO_ROF_CODE = {
  // Xoro 'Rental Equipment' is ROF '6327 Equipment Rental' (word order) —
  // the account behind The Luxury Collection correction (PR #1685).
  "rental equipment": "6327",
  // Xoro's bare inventory-asset account is named just 'Inventory'
  // (F_AccountingTypeName 'OtherCurrentAsset'). ROF's inventory asset is
  // '1201 Inventory'. Confirmed by the GL mirror (#xoro-gl-truth, 2026-07-12):
  // $1.28M of 8007-origin bill legs post to Xoro 'Inventory' — the same
  // inventory-purchase truth as the Item Type='Inventory' signal, just carried
  // on the GL account name instead of the item type. Deterministic.
  "inventory": "1201",
};

// Xoro ItemTypeName values whose lines Xoro posts to the INVENTORY asset
// rather than an expense account. Used by the AP sweep + xoro-verify recon:
// an Inventory-typed line with no expense account name is Xoro's way of
// saying "this is an inventory purchase".
export const XORO_INVENTORY_ITEM_TYPES = new Set(["inventory"]);

/** Parse a raw Xoro account path into { full, leaf, code, name } or null. */
export function parseXoroAccountName(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const segments = s.split(":").map((p) => p.trim()).filter(Boolean);
  const leaf = segments.length ? segments[segments.length - 1] : s;
  const m = leaf.match(/^(\d{3,6})\s+(.+)$/);
  return {
    full: s,
    leaf,
    code: m ? m[1] : null,
    name: (m ? m[2] : leaf).trim(),
  };
}

/**
 * Build a resolver over the entity's gl_accounts rows.
 * @param {Array<{id:string, code:string, name:string, is_postable:boolean,
 *                is_control:boolean, status:string}>} accounts
 * @returns {(raw: string) => {account: object, via: string} | null}
 */
export function buildXoroAccountResolver(accounts) {
  const eligible = (accounts || []).filter(
    (a) => a && a.is_postable && !a.is_control && a.status === "active",
  );
  const byCode = new Map();
  for (const a of eligible) {
    if (!byCode.has(String(a.code))) byCode.set(String(a.code), a);
  }
  const AMBIGUOUS = Symbol("ambiguous");
  const byName = new Map();
  for (const a of eligible) {
    const k = String(a.name || "").trim().toLowerCase();
    if (!k) continue;
    byName.set(k, byName.has(k) ? AMBIGUOUS : a);
  }

  return function resolveXoroAccount(raw) {
    const p = parseXoroAccountName(raw);
    if (!p) return null;
    const leafKey = p.leaf.toLowerCase();
    const nameKey = p.name.toLowerCase();

    // 1. curated dictionary
    const mappedCode = XORO_TO_ROF_CODE[leafKey] ?? XORO_TO_ROF_CODE[nameKey];
    if (mappedCode) {
      const a = byCode.get(String(mappedCode));
      if (a) return { account: a, via: "map" };
    }
    // 2. code + name agree on the same ROF account
    if (p.code) {
      const a = byCode.get(p.code);
      if (a && String(a.name).trim().toLowerCase() === nameKey) {
        return { account: a, via: "code+name" };
      }
    }
    // 3. unique exact name match (code prefix stripped)
    const n = byName.get(nameKey);
    if (n && n !== AMBIGUOUS) return { account: n, via: "name" };
    // 4. unique exact match on the whole leaf
    const l = byName.get(leafKey);
    if (l && l !== AMBIGUOUS) return { account: l, via: "leaf" };
    return null;
  };
}
