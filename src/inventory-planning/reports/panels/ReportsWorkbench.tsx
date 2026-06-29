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

type TabKey = "sales" | "inventory" | "accuracy" | "buy";
const TODAY = new Date().toISOString().slice(0, 10);

const labelStyle: React.CSSProperties = { color: PAL.textMuted, fontSize: 11 };
const sel: React.CSSProperties = { ...S.select, fontSize: 12, padding: "5px 8px" };

export default function ReportsWorkbench() {
  const [ctx, setCtx] = useState<LookupCtx | null>(null);
  const [runs, setRuns] = useState<RepRun[]>([]);
  const [tab, setTab] = useState<TabKey>("sales");
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

  return (
    <div style={S.app}>
      <div style={S.content}>
        {bootErr && <div style={{ color: PAL.red, marginBottom: 12 }}>Load failed — {bootErr}</div>}

        <div style={{ display: "flex", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
          <TabButton active={tab === "sales"} onClick={() => setTab("sales")}>Sales Performance</TabButton>
          <TabButton active={tab === "inventory"} onClick={() => setTab("inventory")}>Inventory Health</TabButton>
          <TabButton active={tab === "accuracy"} onClick={() => setTab("accuracy")}>Forecast Accuracy</TabButton>
          <TabButton active={tab === "buy"} onClick={() => setTab("buy")}>Buy Plan & Supply</TabButton>
        </div>

        {!ctx ? (
          <div style={{ ...S.card, padding: 32, textAlign: "center", color: PAL.textMuted }}>Loading masters…</div>
        ) : (
          <>
            {tab === "sales" && <SalesPanel ctx={ctx} />}
            {tab === "inventory" && <InventoryPanel ctx={ctx} />}
            {tab === "accuracy" && <AccuracyPanel ctx={ctx} runs={runs} />}
            {tab === "buy" && <BuyPanel ctx={ctx} runs={runs} />}
          </>
        )}
      </div>
    </div>
  );
}

// ── Sales Performance ───────────────────────────────────────────────────────
function SalesPanel({ ctx }: { ctx: LookupCtx }) {
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
    () => buildSalesPerformance(sales, ctx, { groupBy, txnType, tyStartIso: tyStart, endIso: end }),
    [sales, ctx, groupBy, txnType, tyStart, end],
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
