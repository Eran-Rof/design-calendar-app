// Build-reconcile service. Loads recommendations across N saved
// builds, groups by vendor, and produces an Excel workbook with one
// sheet per (saved build × vendor) — preserving provenance so the
// planner can hand off each "buy" sheet to the right team without
// losing context on which planning slice it came from.

import XLSXStyle from "xlsx-js-style";
import { wholesaleRepo } from "./wholesalePlanningRepository";
import { scenarioRepo } from "../scenarios/services/scenarioRepo";
import type { IpScenario } from "../scenarios/types/scenarios";
import type { IpItem } from "../types/entities";

export interface ReconcileBuyRow {
  sku_id: string;
  sku_code: string;
  description: string | null;
  style: string | null;
  color: string | null;
  size: string | null;
  customer_id: string;
  customer_name: string;
  period_code: string;
  period_start: string;
  qty: number;
  unit_cost: number | null;
  extended_cost: number | null;
  action: string;
}

export interface ReconcileVendorGroup {
  vendor_id: string | null;
  vendor_name: string;
  rows: ReconcileBuyRow[];
  total_qty: number;
  total_cost: number;
}

export interface ReconcileBuildOutput {
  scenario: IpScenario;
  planning_run_id: string;
  vendors: ReconcileVendorGroup[];
  total_qty: number;
  total_cost: number;
  rec_count: number;
}

// Pull recommendations for each picked build, group by vendor,
// preserving the build identity. Pulls items + customers + vendors
// once and reuses across builds.
export async function loadReconcile(scenarioIds: string[]): Promise<ReconcileBuildOutput[]> {
  if (scenarioIds.length === 0) return [];

  // Load reference data once.
  const [scenarios, items, customers, vendors] = await Promise.all([
    scenarioRepo.listScenarios(),
    wholesaleRepo.listItems(),
    wholesaleRepo.listCustomers(),
    wholesaleRepo.listVendors(),
  ]);
  const scenarioById = new Map(scenarios.map((s) => [s.id, s]));
  const itemById = new Map(items.map((i) => [i.id, i]));
  const customerById = new Map(customers.map((c) => [c.id, c]));
  const vendorById = new Map(vendors.map((v) => [v.id, v]));

  const outputs: ReconcileBuildOutput[] = [];
  for (const scenarioId of scenarioIds) {
    const scenario = scenarioById.get(scenarioId);
    if (!scenario) continue;
    const recs = await wholesaleRepo.listRecommendations(scenario.planning_run_id);
    // Only "buy" + "expedite" actions with qty > 0 — those translate
    // directly to a PO line. "monitor" / "hold" / "reduce" are
    // planner-decision rows, not buy candidates.
    const buyable = recs.filter(
      (r) => (r.recommended_action === "buy" || r.recommended_action === "expedite")
        && (r.recommended_qty ?? 0) > 0,
    );

    // Bucket by vendor (per item.vendor_id). SKUs without a vendor
    // land in a synthetic "(unassigned)" group so the planner can
    // see them and chase the master gap.
    const byVendor = new Map<string, ReconcileVendorGroup>();
    for (const r of buyable) {
      const item = itemById.get(r.sku_id);
      const vid = item?.vendor_id ?? null;
      const key = vid ?? "__unassigned__";
      let g = byVendor.get(key);
      if (!g) {
        const vname = vid ? (vendorById.get(vid)?.name ?? `Vendor ${vid.slice(0, 8)}`) : "(unassigned)";
        g = { vendor_id: vid, vendor_name: vname, rows: [], total_qty: 0, total_cost: 0 };
        byVendor.set(key, g);
      }
      const qty = r.recommended_qty ?? 0;
      const cost = item?.unit_cost ?? null;
      const ext = cost != null ? cost * qty : null;
      const customer = customerById.get(r.customer_id);
      g.rows.push({
        sku_id: r.sku_id,
        sku_code: item?.sku_code ?? r.sku_id,
        description: item?.description ?? null,
        style: item?.style_code ?? null,
        color: item?.color ?? null,
        size: item?.size ?? null,
        customer_id: r.customer_id,
        customer_name: customer?.name ?? r.customer_id,
        period_code: r.period_start.slice(0, 7),
        period_start: r.period_start,
        qty,
        unit_cost: cost,
        extended_cost: ext,
        action: r.recommended_action,
      });
      g.total_qty += qty;
      if (ext != null) g.total_cost += ext;
    }

    // Sort vendors alphabetically (unassigned last).
    const vendorList = Array.from(byVendor.values()).sort((a, b) => {
      if (a.vendor_id === null && b.vendor_id !== null) return 1;
      if (b.vendor_id === null && a.vendor_id !== null) return -1;
      return a.vendor_name.localeCompare(b.vendor_name);
    });
    // Sort rows within each vendor: period asc, then sku.
    for (const g of vendorList) {
      g.rows.sort((a, b) => {
        if (a.period_start !== b.period_start) return a.period_start.localeCompare(b.period_start);
        return a.sku_code.localeCompare(b.sku_code);
      });
    }

    outputs.push({
      scenario,
      planning_run_id: scenario.planning_run_id,
      vendors: vendorList,
      total_qty: vendorList.reduce((acc, g) => acc + g.total_qty, 0),
      total_cost: vendorList.reduce((acc, g) => acc + g.total_cost, 0),
      rec_count: buyable.length,
    });
  }
  return outputs;
}

// Excel layout: one summary sheet ("Overview") + one sheet per
// (saved build × vendor). Sheet names are tab-truncated to 31 chars
// per Excel's spec.
export function exportReconcileWorkbook(outputs: ReconcileBuildOutput[]): void {
  if (outputs.length === 0) return;
  const wb = XLSXStyle.utils.book_new();

  // Overview sheet — totals per (build, vendor).
  const summaryRows: Record<string, unknown>[] = [];
  for (const o of outputs) {
    for (const g of o.vendors) {
      summaryRows.push({
        Build: o.scenario.scenario_name,
        Vendor: g.vendor_name,
        SKUs: g.rows.length,
        "Total Qty": g.total_qty,
        "Total Cost": g.total_cost.toFixed(2),
      });
    }
    summaryRows.push({ Build: `${o.scenario.scenario_name} — TOTAL`, Vendor: "", SKUs: o.rec_count, "Total Qty": o.total_qty, "Total Cost": o.total_cost.toFixed(2) });
  }
  XLSXStyle.utils.book_append_sheet(wb, sheet(summaryRows), "Overview");

  // One sheet per (build × vendor).
  const usedNames = new Set<string>();
  for (const o of outputs) {
    for (const g of o.vendors) {
      const baseName = `${slug(o.scenario.scenario_name, 12)}__${slug(g.vendor_name, 14)}`;
      const name = uniqueSheetName(baseName, usedNames);
      usedNames.add(name);
      const rows = g.rows.map((r) => ({
        SKU: r.sku_code,
        Description: r.description ?? "",
        Style: r.style ?? "",
        Color: r.color ?? "",
        Size: r.size ?? "",
        Customer: r.customer_name,
        Period: r.period_code,
        Qty: r.qty,
        "Unit Cost": r.unit_cost ?? "",
        "Extended Cost": r.extended_cost != null ? r.extended_cost.toFixed(2) : "",
        Action: r.action,
      }));
      XLSXStyle.utils.book_append_sheet(wb, sheet(rows), name);
    }
  }

  const fileName = `build_reconcile_${today()}.xlsx`;
  const buf = XLSXStyle.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  const blob = new Blob([buf], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

// ── helpers ───────────────────────────────────────────────────────────────
const HDR: XLSXStyle.CellStyle = {
  font: { bold: true, color: { rgb: "FFFFFF" }, sz: 11, name: "Calibri" },
  fill: { fgColor: { rgb: "1F497D" }, patternType: "solid" },
  alignment: { horizontal: "center", vertical: "center" },
};

function sheet(rows: Record<string, unknown>[]): XLSXStyle.WorkSheet {
  if (rows.length === 0) return XLSXStyle.utils.aoa_to_sheet([["(no rows)"]]);
  const headers = Object.keys(rows[0]);
  const aoa: unknown[][] = [headers, ...rows.map((r) => headers.map((h) => r[h]))];
  const ws = XLSXStyle.utils.aoa_to_sheet(aoa);
  for (let c = 0; c < headers.length; c++) {
    const cell = XLSXStyle.utils.encode_cell({ r: 0, c });
    if (ws[cell]) ws[cell].s = HDR;
  }
  ws["!cols"] = headers.map((h) => ({ wch: Math.min(40, Math.max(10, h.length + 2)) }));
  return ws;
}

function slug(s: string, max: number): string {
  return s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, max) || "x";
}
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// Excel limits sheet names to 31 chars and disallows duplicates. If
// the chosen base collides with an earlier sheet, append _2 / _3 / ...
function uniqueSheetName(base: string, used: Set<string>): string {
  let candidate = base.slice(0, 31);
  let i = 2;
  while (used.has(candidate)) {
    const suffix = `_${i}`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
    i++;
  }
  return candidate;
}
