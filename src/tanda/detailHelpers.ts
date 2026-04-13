/**
 * Pure helper functions extracted from detailPanel.tsx and milestonesTab.tsx
 * for testability without browser dependencies.
 */

import { itemQty } from "../utils/tandaTypes";

/** Days until a date string. Returns null for falsy input. Uses Math.ceil. */
export function daysUntil(d?: string): number | null {
  if (!d) return null;
  return Math.ceil((new Date(d).getTime() - Date.now()) / 86400000);
}

export type MatrixRow = { base: string; color: string; desc: string; qty: number; price: number };

/**
 * Group PO line items into matrix rows keyed by base SKU + color.
 * 4-part SKU "BASE-CLR1-CLR2-SIZE" => color = "CLR1-CLR2"
 * 2/3-part SKU "BASE-X[-Y]"        => color = X (second segment)
 * 1-part SKU "BASE"                 => color = ""
 */
export function computeMatrixRows(items: any[]): MatrixRow[] {
  const byKey: Record<string, MatrixRow> = {};
  const rows: MatrixRow[] = [];
  items.forEach((item: any) => {
    const sku = item.ItemNumber ?? "";
    const parts = sku.split("-");
    const color = parts.length === 4 ? `${parts[1]}-${parts[2]}` : (parts.length >= 2 ? parts[1] : "");
    const base = parts[0] || sku;
    const key = `${base}-${color}`;
    if (!byKey[key]) {
      byKey[key] = { base, color, desc: item.Description ?? "", qty: 0, price: item.UnitPrice ?? 0 };
      rows.push(byKey[key]);
    }
    byKey[key].qty += itemQty(item);
  });
  return rows;
}

export interface CascadeInfo { blocked: boolean; upstreamDelay: number; delayedCat: string }

/**
 * Compute cascade / blocking info for a given WIP category.
 * Checks all prior categories (by activeCats order) and returns
 * whether the category is blocked, the max upstream delay in days,
 * and which category caused the delay.
 */
export function computeCascadeInfo(
  cat: string,
  activeCats: string[],
  grouped: Record<string, { status: string; expected_date?: string | null }[]>,
  now: number = Date.now(),
): CascadeInfo {
  const info: CascadeInfo = { blocked: false, upstreamDelay: 0, delayedCat: "" };
  const catIdx = activeCats.indexOf(cat);
  for (let p = 0; p < catIdx; p++) {
    const prevCat = activeCats[p];
    const prevMs = grouped[prevCat] || [];
    const prevDone = prevMs.every(m => m.status === "Complete" || m.status === "N/A");
    if (!prevDone) {
      info.blocked = true;
      const maxLate = prevMs.reduce((max, m) => {
        if (m.status === "Complete" || m.status === "N/A" || !m.expected_date) return max;
        const daysLate = Math.ceil((now - new Date(m.expected_date).getTime()) / 86400000);
        return daysLate > 0 ? Math.max(max, daysLate) : max;
      }, 0);
      if (maxLate > info.upstreamDelay) { info.upstreamDelay = maxLate; info.delayedCat = prevCat; }
    }
  }
  return info;
}

/** Sort milestones within a category: by expected_date asc, then sort_order. */
export function sortCategoryMilestones<T extends { expected_date?: string | null; sort_order: number }>(ms: T[]): T[] {
  return [...ms].sort((a, b) => {
    if (a.expected_date && b.expected_date) { const d = a.expected_date.localeCompare(b.expected_date); if (d !== 0) return d; }
    if (a.expected_date && !b.expected_date) return -1;
    if (!a.expected_date && b.expected_date) return 1;
    return a.sort_order - b.sort_order;
  });
}
