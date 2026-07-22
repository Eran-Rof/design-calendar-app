// Planning Reports hub — mounts at /planning/reports.
//
// A single screen with four best-in-class analytical reports, each viewable
// on screen and downloadable to Excel via the universal ExportButton:
//   • Sales Performance   — wholesale sales by grain, YoY, ABC
//   • Inventory Health    — on-hand value, weeks of supply, stockout/excess
//   • Forecast Accuracy   — MAPE & bias, system vs final (per run)
//   • Buy Plan & Supply   — buy recs + open-PO coverage (per run)
//
// Shared masters load once into a lookup context; each report panel loads its
// own fact data and computes a pure ReportResult rendered by <ReportTable>.

import { useCallback, useEffect, useMemo, useState } from "react";
import { S, PAL } from "../../components/styles";
import { TabButton } from "../../components/TabButton";
import { AppDatePicker } from "../../../shared/components/AppDatePicker";
import ReportTable from "../components/ReportTable";
import { reportsRepo, type RepRun, type RepSaleW } from "../services/reportsRepository";
import { buildLookups, type LookupCtx, num, shiftMonths } from "../lib/aggUtils";
import { buildSalesPerformance, type SalesGroupBy } from "../reports/salesPerformance";
import { buildInventoryHealth, type InvGroupBy } from "../reports/inventoryHealth";
import { buildForecastAccuracy, type AccGroupBy } from "../reports/forecastAccuracy";
import { buildBuyPlanSupply, type BuyGroupBy } from "../reports/buyPlanSupply";
import SearchableSelect from "../../../tanda/components/SearchableSelect";
import { useCanSeeMargins } from "../../../hooks/useCanSeeMargins";
import { wholesaleRepo } from "../../services/wholesalePlanningRepository";
import { buildGridRows } from "../../services/wholesaleForecastService";
import { BuyerVsLyReportView } from "../../panels/wholesale-planning/BuyerVsLyReportView";
import type { ReportMetric } from "../../panels/wholesale-planning/buildBuyerVsLyReport";
import type { IpPlanningGridRow, IpPlanningRun } from "../../types/wholesale";

type TabKey = "sales" | "inventory" | "accuracy" | "buy" | "buyerVsLy" | "buyVsLy";
const TODAY = new Date().toISOString().slice(0, 10);

const labelStyle: React.CSSProperties = { color: PAL.textMuted, fontSize: 11 };
const sel: React.CSSProperties = { ...S.select, fontSize: 12, padding: "5px 8px" };

// The report picker — one card per report on the selection page.
const REPORTS: Array<{ key: TabKey; label: string; desc: string }> = [
  { key: "sales", label: "Sales Performance", desc: "Wholesale sales by grain, YoY, ABC" },
  { key: "inventory", label: "Inventory Health", desc: "On-hand value, weeks of supply, stockout / excess" },
  { key: "accuracy", label: "Forecast Accuracy", desc: "MAPE & bias, system vs final (per run)" },
  { key: "buy", label: "Buy Plan & Supply", desc: "Buy recs + open-PO coverage (per run)" },
  { key: "buyerVsLy", label: "Buyer vs LY", desc: "Buyer quantities vs same-period-last-year, per customer" },
  { key: "buyVsLy", label: "Buy vs LY", desc: "Buy quantities vs same-period-last-year, per customer" },
];

export default function ReportsWorkbench() {
  const [ctx, setCtx] = useState<LookupCtx | null>(null);
  const [runs, setRuns] = useState<RepRun[]>([]);
  // null = the report selection page. Picking a report opens it; its Close
  // button returns here.
  const [tab, setTab] = useState<TabKey | null>(null);
  const [bootErr, setBootErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [items, categories, customers, channels, vendors, avgCosts, runList] = await Promise.all([
          reportsRepo.listItems(), reportsRepo.listCategories(), reportsRepo.listCustomers(),
          reportsRepo.listChannels(), reportsRepo.listVendors(), reportsRepo.listAvgCosts(), reportsRepo.listRuns(),
        ]);
        setCtx(buildLookups({ items, categories, customers, channels, vendors, avgCosts }));
        setRuns(runList);
      } catch (e) {
        setBootErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  const active = REPORTS.find((r) => r.key === tab) ?? null;

  return (
    <div style={S.app}>
      <div style={S.content}>
        {bootErr && <div style={{ color: PAL.red, marginBottom: 12 }}>Load failed — {bootErr}</div>}

        {tab === null ? (
          /* Report selection page — pick a report to open. */
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: PAL.text, marginBottom: 12 }}>Reports</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
              {REPORTS.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => setTab(r.key)}
                  style={{ ...S.card, textAlign: "left", cursor: "pointer", padding: 16, border: `1px solid ${PAL.border}`, background: PAL.panel, fontFamily: "inherit" }}
                >
                  <div style={{ fontSize: 14, fontWeight: 700, color: PAL.accent, marginBottom: 4 }}>{r.label}</div>
                  <div style={{ fontSize: 12, color: PAL.textMuted }}>{r.desc}</div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {/* Close bar — ✕ and Close return to the selection page. */}
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
              <button
                type="button"
                onClick={() => setTab(null)}
                title="Close this report and go back to the report list"
                style={{ background: "transparent", border: `1px solid ${PAL.border}`, color: PAL.textDim, borderRadius: 8, padding: "6px 10px", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}
              >✕</button>
              <div style={{ flex: 1, fontSize: 15, fontWeight: 700, color: PAL.text }}>{active?.label}</div>
              <button
                type="button"
                onClick={() => setTab(null)}
                style={{ background: "transparent", border: `1px solid ${PAL.border}`, color: PAL.textDim, borderRadius: 8, padding: "6px 14px", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}
              >Close</button>
            </div>

            {/* The Buyer/Buy vs LY reports build directly from the planning run's
                grid rows and don't need the shared masters context. */}
            {tab === "buyerVsLy" ? (
              <BuyerVsLyPanel metric="buyer" />
            ) : tab === "buyVsLy" ? (
              <BuyerVsLyPanel metric="buy" />
            ) : !ctx ? (
              <div style={{ ...S.card, padding: 32, textAlign: "center", color: PAL.textMuted }}>Loading masters…</div>
            ) : (
              <>
                {tab === "sales" && <SalesPanel ctx={ctx} />}
                {tab === "inventory" && <InventoryPanel ctx={ctx} />}
                {tab === "accuracy" && <AccuracyPanel ctx={ctx} runs={runs} />}
                {tab === "buy" && <BuyPanel ctx={ctx} runs={runs} />}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Buyer vs LY / Buy vs LY ─────────────────────────────────────────────────
// One panel, two metrics: TY block = the run's Buyer (buyer_request_qty) or Buy
// (planned_buy_qty). Builds the same grid rows the Wholesale workbench renders
// (buildGridRows), then the shared pivot view. Report was moved here from the
// grid toolbar so it lives under Reports in the menu.
function BuyerVsLyPanel({ metric }: { metric: ReportMetric }) {
  const [runs, setRuns] = useState<IpPlanningRun[]>([]);
  const [runId, setRunId] = useState("");
  const [rows, setRows] = useState<IpPlanningGridRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    wholesaleRepo.listPlanningRuns("wholesale")
      .then((list) => { setRuns(list); if (list[0]) setRunId((cur) => cur || list[0].id); })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const run = useMemo(() => runs.find((r) => r.id === runId) ?? null, [runs, runId]);

  useEffect(() => {
    if (!run) { setRows(null); return; }
    let cancelled = false;
    setBusy(true); setErr(null);
    buildGridRows(run)
      .then((r) => { if (!cancelled) setRows(r); })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [run]);

  return (
    <div style={S.card}>
      <div style={{ ...S.toolbar, marginBottom: 12 }}>
        <span style={labelStyle}>Planning run</span>
        <SearchableSelect value={runId} onChange={(v) => setRunId(v)} inputStyle={sel}
          options={runs.map((r) => ({ value: r.id, label: `${r.name} · ${r.planning_scope} · ${r.status}` }))} />
      </div>
      {err && <div style={{ color: PAL.red, marginBottom: 12 }}>Load failed — {err}</div>}
      {busy ? (
        <div style={{ padding: 32, textAlign: "center", color: PAL.textMuted }}>Building report…</div>
      ) : rows ? (
        <BuyerVsLyReportView fullRows={rows} runName={run?.name ?? "Planning run"} metric={metric} />
      ) : (
        <div style={{ padding: 32, textAlign: "center", color: PAL.textMuted }}>Pick a planning run to build the report.</div>
      )}
    </div>
  );
}

// ── Sales Performance ───────────────────────────────────────────────────────
function SalesPanel({ ctx }: { ctx: LookupCtx }) {
  // Margin visibility gate. The report builder is a pure module and cannot call
  // the RBAC hook, so we thread the viewer's permission in. View + export are
  // unified through the same ReportResult, so canView drives both. Fails open.
  const { canView: canViewMargin } = useCanSeeMargins();
  const [groupBy, setGroupBy] = useState<SalesGroupBy>("month");
  const [txnType, setTxnType] = useState("invoice");
  const [tyStart, setTyStart] = useState(shiftMonths(TODAY, -12));
  const [end, setEnd] = useState(TODAY);
  const [sales, setSales] = useState<RepSaleW[]>([]);
  const [busy, setBusy] = useState(true);

  // Load TY + LY window (24 months back from `end` start) so YoY is available.
  const load = useCallback(async () => {
    setBusy(true);
    try {
      const from = shiftMonths(tyStart, -12);
      setSales(await reportsRepo.listWholesaleSales(from, end));
    } finally { setBusy(false); }
  }, [tyStart, end]);
  useEffect(() => { void load(); }, [load]);

  const txnTypes = useMemo(() => {
    const set = new Set<string>();
    for (const s of sales) if (s.txn_type) set.add(s.txn_type);
    return ["all", ...[...set].sort()];
  }, [sales]);

  const result = useMemo(
    () => buildSalesPerformance(sales, ctx, { groupBy, txnType, tyStartIso: tyStart, endIso: end }, { includeMargins: canViewMargin }),
    [sales, ctx, groupBy, txnType, tyStart, end, canViewMargin],
  );

  return (
    <div style={{ ...S.card }}>
      <div style={{ ...S.toolbar, marginBottom: 12 }}>
        <span style={labelStyle}>Group by</span>
        <SearchableSelect value={groupBy} onChange={(v) => setGroupBy(v as SalesGroupBy)} inputStyle={sel} options={[
          { value: "month", label: "Month" }, { value: "category", label: "Category" },
          { value: "customer", label: "Customer" }, { value: "channel", label: "Channel" }, { value: "sku", label: "SKU" },
        ]} />
        <span style={labelStyle}>Txn type</span>
        <SearchableSelect value={txnType} onChange={(v) => setTxnType(v)} inputStyle={sel}
          options={txnTypes.map((t) => ({ value: t, label: t }))} />
        <span style={labelStyle}>TY from</span>
        <AppDatePicker style={{ ...S.input, width: 130, fontSize: 12, padding: "4px 8px" }} value={tyStart} onCommit={setTyStart} />
        <span style={labelStyle}>to</span>
        <AppDatePicker style={{ ...S.input, width: 130, fontSize: 12, padding: "4px 8px" }} value={end} onCommit={setEnd} />
      </div>
      <ReportTable result={result} busy={busy} filename="planning-sales-performance" sheetName="Sales Performance" />
    </div>
  );
}

// ── Inventory Health ────────────────────────────────────────────────────────
function InventoryPanel({ ctx }: { ctx: LookupCtx }) {
  const [groupBy, setGroupBy] = useState<InvGroupBy>("category");
  const [velocity, setVelocity] = useState<Map<string, number>>(new Map());
  const [inventory, setInventory] = useState<Awaited<ReturnType<typeof reportsRepo.listInventory>>>([]);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    (async () => {
      setBusy(true);
      try {
        const from = shiftMonths(TODAY, -3); // ~13 weeks for velocity
        const [inv, recentSales] = await Promise.all([
          reportsRepo.listInventory(),
          reportsRepo.listWholesaleSales(from, TODAY),
        ]);
        setInventory(inv);
        // Weekly velocity per item: prefer invoice rows; fall back to all.
        const hasInvoice = recentSales.some((s) => s.txn_type === "invoice");
        const map = new Map<string, number>();
        for (const s of recentSales) {
          if (hasInvoice && s.txn_type !== "invoice") continue;
          map.set(s.sku_id, (map.get(s.sku_id) ?? 0) + num(s.qty));
        }
        for (const [k, v] of map) map.set(k, v / 13);
        setVelocity(map);
      } finally { setBusy(false); }
    })();
  }, []);

  const result = useMemo(() => buildInventoryHealth(inventory, ctx, { groupBy, weeklyVelocity: velocity }), [inventory, ctx, groupBy, velocity]);

  return (
    <div style={S.card}>
      <div style={{ ...S.toolbar, marginBottom: 12 }}>
        <span style={labelStyle}>Group by</span>
        <SearchableSelect value={groupBy} onChange={(v) => setGroupBy(v as InvGroupBy)} inputStyle={sel} options={[
          { value: "category", label: "Category" }, { value: "sku", label: "SKU" }, { value: "warehouse", label: "Warehouse" },
        ]} />
      </div>
      <ReportTable result={result} busy={busy} filename="planning-inventory-health" sheetName="Inventory Health" />
    </div>
  );
}

// ── Forecast Accuracy ───────────────────────────────────────────────────────
function AccuracyPanel({ ctx, runs }: { ctx: LookupCtx; runs: RepRun[] }) {
  const [runId, setRunId] = useState(runs[0]?.id ?? "");
  const [groupBy, setGroupBy] = useState<AccGroupBy>("method");
  const [rows, setRows] = useState<Awaited<ReturnType<typeof reportsRepo.listAccuracy>>>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!runId && runs[0]) setRunId(runs[0].id); }, [runs, runId]);
  useEffect(() => {
    if (!runId) return;
    setBusy(true);
    reportsRepo.listAccuracy(runId).then(setRows).finally(() => setBusy(false));
  }, [runId]);

  const result = useMemo(() => buildForecastAccuracy(rows, ctx, groupBy), [rows, ctx, groupBy]);

  return (
    <div style={S.card}>
      <div style={{ ...S.toolbar, marginBottom: 12 }}>
        <span style={labelStyle}>Planning run</span>
        <SearchableSelect value={runId} onChange={(v) => setRunId(v)} inputStyle={sel}
          options={runs.map((r) => ({ value: r.id, label: `${r.name} · ${r.planning_scope} · ${r.status}` }))} />
        <span style={labelStyle}>Group by</span>
        <SearchableSelect value={groupBy} onChange={(v) => setGroupBy(v as AccGroupBy)} inputStyle={sel} options={[
          { value: "method", label: "Method" }, { value: "category", label: "Category" },
          { value: "period", label: "Period" }, { value: "sku", label: "SKU" },
        ]} />
      </div>
      <ReportTable result={result} busy={busy} filename="planning-forecast-accuracy" sheetName="Forecast Accuracy" />
    </div>
  );
}

// ── Buy Plan & Supply ───────────────────────────────────────────────────────
function BuyPanel({ ctx, runs }: { ctx: LookupCtx; runs: RepRun[] }) {
  const [runId, setRunId] = useState(runs[0]?.id ?? "");
  const [groupBy, setGroupBy] = useState<BuyGroupBy>("category");
  const [recs, setRecs] = useState<Awaited<ReturnType<typeof reportsRepo.listRecommendations>>>([]);
  const [openPos, setOpenPos] = useState<Awaited<ReturnType<typeof reportsRepo.listOpenPos>>>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!runId && runs[0]) setRunId(runs[0].id); }, [runs, runId]);
  useEffect(() => { reportsRepo.listOpenPos().then(setOpenPos); }, []);
  useEffect(() => {
    if (!runId) { setRecs([]); return; }
    setBusy(true);
    reportsRepo.listRecommendations(runId).then(setRecs).finally(() => setBusy(false));
  }, [runId]);

  const result = useMemo(() => buildBuyPlanSupply(recs, openPos, ctx, groupBy), [recs, openPos, ctx, groupBy]);

  const supplyMode = groupBy === "vendor" || groupBy === "receipt_month";

  return (
    <div style={S.card}>
      <div style={{ ...S.toolbar, marginBottom: 12 }}>
        <span style={labelStyle}>Group by</span>
        <SearchableSelect value={groupBy} onChange={(v) => setGroupBy(v as BuyGroupBy)} inputStyle={sel} options={[
          { value: "category", label: "Category (buy)" }, { value: "sku", label: "SKU (buy)" },
          { value: "priority", label: "Priority (buy)" },
          { value: "vendor", label: "Vendor (open PO)" }, { value: "receipt_month", label: "Receipt month (open PO)" },
        ]} />
        {!supplyMode && (
          <>
            <span style={labelStyle}>Planning run</span>
            <SearchableSelect value={runId} onChange={(v) => setRunId(v)} inputStyle={sel}
              options={runs.map((r) => ({ value: r.id, label: `${r.name} · ${r.planning_scope} · ${r.status}` }))} />
          </>
        )}
      </div>
      <ReportTable result={result} busy={busy && !supplyMode} filename="planning-buy-plan-supply" sheetName="Buy Plan & Supply" />
    </div>
  );
}
