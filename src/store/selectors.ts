/**
 * Derived state selectors — pure functions that compute values from store state.
 * Used by panels instead of receiving pre-computed values via ctx.
 */
import { BRANDS } from "../utils/constants";
import { getDaysUntil } from "../utils/dates";
import type { AppStore } from "./index";

export function selectGetBrand(s: AppStore) {
  return (id: string) => s.brands.find((b: any) => b.id === id) || s.brands[0] || BRANDS[0];
}

export function selectIsAdmin(s: AppStore) {
  return s.currentUser?.role === "admin";
}

export function selectCanViewAll(s: AppStore) {
  return s.currentUser?.role === "admin" || s.currentUser?.permissions?.view_all;
}

export function selectVisibleTasks(s: AppStore) {
  const canViewAll = selectCanViewAll(s);
  return canViewAll ? s.tasks : s.tasks.filter((t: any) => t.assigneeId === s.currentUser?.teamMemberId);
}

export function selectFiltered(s: AppStore) {
  const visible = selectVisibleTasks(s);
  return visible.filter((t: any) => {
    const collKey = `${t.brand}||${t.collection}`;
    const coll = s.collections[collKey] || {};
    return (
      (s.filterBrand.size === 0 || s.filterBrand.has(t.brand)) &&
      (s.filterSeason.size === 0 || s.filterSeason.has(t.season)) &&
      (s.filterCustomer.size === 0 || s.filterCustomer.has(coll.customer || "")) &&
      (s.filterVendor.size === 0 || s.filterVendor.has(t.vendorName || ""))
    );
  });
}

export function selectOverdue(s: AppStore) {
  return selectFiltered(s).filter((t: any) => getDaysUntil(t.due) < 0 && t.status !== "Complete");
}

export function selectDueThisWeek(s: AppStore) {
  return selectFiltered(s).filter((t: any) => {
    const d = getDaysUntil(t.due);
    return d >= 0 && d <= 7 && t.status !== "Complete";
  });
}

export function selectDue30(s: AppStore) {
  return selectFiltered(s).filter((t: any) => {
    const d = getDaysUntil(t.due);
    return d > 7 && d <= 30 && t.status !== "Complete";
  });
}

export function selectCollMap(s: AppStore) {
  const map: Record<string, any> = {};
  s.tasks.forEach((t: any) => {
    const k = `${t.brand}||${t.collection}`;
    if (!map[k]) map[k] = { brand: t.brand, collection: t.collection, season: t.season, category: t.category, vendorName: t.vendorName, tasks: [], key: k };
    map[k].tasks.push(t);
  });
  return map;
}

export function selectCollList(s: AppStore) {
  const collMap = selectCollMap(s);
  return Object.values(collMap).filter((c: any) => {
    const collKey = `${c.brand}||${c.collection}`;
    const coll = s.collections[collKey] || {};
    return (
      (s.filterBrand.size === 0 || s.filterBrand.has(c.brand)) &&
      (s.filterSeason.size === 0 || s.filterSeason.has(c.season)) &&
      (s.filterCustomer.size === 0 || s.filterCustomer.has(coll.customer || "")) &&
      (s.filterVendor.size === 0 || s.filterVendor.has(c.vendorName || ""))
    );
  });
}
