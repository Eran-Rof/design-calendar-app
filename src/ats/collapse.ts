import type { ATSRow } from "./types";

export type CollapseLevel = "none" | "category" | "subCategory" | "style";

const NONE = "(none)";

function partsFor(row: ATSRow, level: CollapseLevel): string[] | null {
  if (level === "none") return null;
  const cat = (row.master_category ?? "").trim() || NONE;
  if (level === "category") return [cat];
  const sub = (row.master_sub_category ?? "").trim() || NONE;
  if (level === "subCategory") return [cat, sub];
  const sty = (row.master_style ?? "").trim() || NONE;
  return [cat, sub, sty];
}

export function groupKeyFor(row: ATSRow, level: CollapseLevel): string | null {
  const parts = partsFor(row, level);
  if (!parts) return null;
  return `${level}:${parts.join(":")}`;
}

function buildAggregate(level: Exclude<CollapseLevel, "none">, key: string, parts: string[], children: ATSRow[]): ATSRow {
  let onHand = 0;
  let onOrder = 0;
  let onPO = 0;
  const dates: Record<string, number> = {};
  let anyFree = false;
  for (const c of children) {
    onHand += c.onHand;
    onOrder += c.onOrder;
    onPO += c.onPO;
    for (const [d, q] of Object.entries(c.dates)) {
      dates[d] = (dates[d] ?? 0) + q;
    }
    if (c.freeMap) anyFree = true;
  }
  let freeMap: Record<string, number> | undefined;
  if (anyFree) {
    freeMap = {};
    for (const c of children) {
      if (!c.freeMap) continue;
      for (const [d, q] of Object.entries(c.freeMap)) {
        freeMap[d] = (freeMap[d] ?? 0) + q;
      }
    }
  }
  return {
    sku: `__group:${level}:${key}`,
    description: `(${children.length} items)`,
    store: undefined,
    dates,
    freeMap,
    onPO,
    onOrder,
    onHand,
    master_category: parts[0],
    master_sub_category: level === "subCategory" || level === "style" ? parts[1] : null,
    master_style: level === "style" ? parts[2] : null,
    master_color: null,
    master_match_source: "style",
    __collapsed: { level, key, childCount: children.length },
  };
}

export function collapseRows(rows: ATSRow[], level: CollapseLevel, expandedGroups: ReadonlySet<string>): ATSRow[] {
  if (level === "none") return rows;

  const groups = new Map<string, { parts: string[]; children: ATSRow[] }>();
  const order: string[] = [];
  for (const r of rows) {
    const parts = partsFor(r, level)!;
    const key = `${level}:${parts.join(":")}`;
    let g = groups.get(key);
    if (!g) {
      g = { parts, children: [] };
      groups.set(key, g);
      order.push(key);
    }
    g.children.push(r);
  }

  order.sort((a, b) => {
    const ga = groups.get(a)!.parts;
    const gb = groups.get(b)!.parts;
    for (let i = 0; i < ga.length; i++) {
      const cmp = ga[i].localeCompare(gb[i]);
      if (cmp !== 0) return cmp;
    }
    return 0;
  });

  const out: ATSRow[] = [];
  for (const key of order) {
    const g = groups.get(key)!;
    out.push(buildAggregate(level, key, g.parts, g.children));
    if (expandedGroups.has(key)) {
      // Order children within an expanded group: ROF first, then ROF ECOM,
      // then PT, then anything else — alphabetical fallback. Without this,
      // children appear in input order which can push ROF (the bulk of PO
      // data) onto a later page, making expanded groups look empty of PO
      // data when "All stores" is selected. Within each store, preserve
      // the upstream sort order via a stable sort.
      const sorted = stableSortByStore(g.children);
      for (const c of sorted) out.push(c);
    }
  }
  return out;
}

function storeRank(s: string | null | undefined): number {
  const k = (s ?? "ROF").trim().toUpperCase();
  if (k === "ROF") return 0;
  if (k === "ROF ECOM") return 1;
  if (k === "PT") return 2;
  return 100;
}
function stableSortByStore(rows: ATSRow[]): ATSRow[] {
  // Stable sort by storeRank; ties keep their input order. Native
  // Array.sort is stable in modern JS engines.
  return [...rows].sort((a, b) => storeRank(a.store) - storeRank(b.store));
}
