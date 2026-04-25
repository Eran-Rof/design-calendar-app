// Phase 5 parent page at /planning/accuracy. Tabs:
//   • Accuracy dashboard
//   • Override effectiveness
//   • Anomalies
//   • Suggestions

import { useCallback, useEffect, useMemo, useState } from "react";
import type { IpItem, IpCategory, IpCustomer, IpChannel } from "../../types/entities";
import type { IpPlanningRun } from "../../types/wholesale";
import type {
  IpForecastAccuracy,
  IpOverrideEffectiveness,
} from "../types/accuracy";
import type { IpAiSuggestion, IpPlanningAnomaly } from "../../intelligence/types/intelligence";
import { wholesaleRepo } from "../../services/wholesalePlanningRepository";
import { ecomRepo } from "../../ecom/services/ecomForecastRepo";
import { accuracyRepo, runAccuracyAndIntelligencePass } from "../services";
import { S, PAL, formatDate } from "../../components/styles";
import Toast, { type ToastMessage } from "../../components/Toast";
import ForecastAccuracyDashboard from "./ForecastAccuracyDashboard";
import OverrideEffectivenessPanel from "./OverrideEffectivenessPanel";
import AnomalyQueue from "../../intelligence/panels/AnomalyQueue";
import AISuggestionPanel from "../../intelligence/panels/AISuggestionPanel";
import AIDemandPanel from "../../intelligence/panels/AIDemandPanel";

type TabKey = "accuracy" | "overrides" | "anomalies" | "suggestions" | "ai_demand";

export default function AccuracyWorkbench() {
  const [runs, setRuns] = useState<IpPlanningRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [rows, setRows] = useState<IpForecastAccuracy[]>([]);
  const [overrideEff, setOverrideEff] = useState<IpOverrideEffectiveness[]>([]);
  const [anomalies, setAnomalies] = useState<IpPlanningAnomaly[]>([]);
  const [suggestions, setSuggestions] = useState<IpAiSuggestion[]>([]);
  const [items, setItems] = useState<IpItem[]>([]);
  const [categories, setCategories] = useState<IpCategory[]>([]);
  const [customers, setCustomers] = useState<IpCustomer[]>([]);
  const [channels, setChannels] = useState<IpChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [tab, setTab] = useState<TabKey>("accuracy");
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const selected = useMemo(() => runs.find((r) => r.id === selectedRunId) ?? null, [runs, selectedRunId]);
  const skuCodeById = useMemo(() => new Map(items.map((i) => [i.id, i.sku_code])), [items]);
  const categoryNameById = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);
  const customerNameById = useMemo(() => new Map(customers.map((c) => [c.id, c.name])), [customers]);
  const channelNameById = useMemo(() => new Map(channels.map((ch) => [ch.id, ch.name])), [channels]);

  const loadRuns = useCallback(async () => {
    const [a, w, e] = await Promise.all([
      wholesaleRepo.listPlanningRuns("all"),
      wholesaleRepo.listPlanningRuns("wholesale"),
      wholesaleRepo.listPlanningRuns("ecom"),
    ]);
    const combined = Array.from(new Map([...a, ...w, ...e].map((r) => [r.id, r])).values());
    setRuns(combined);
    if (!selectedRunId && combined.length > 0) {
      const active = combined.find((r) => r.status === "active") ?? combined[0];
      setSelectedRunId(active.id);
    }
  }, [selectedRunId]);

  const loadRunData = useCallback(async () => {
    if (!selected) { setRows([]); setOverrideEff([]); setAnomalies([]); setSuggestions([]); return; }
    const [acc, ov, an, su] = await Promise.all([
      accuracyRepo.listAccuracy({ planning_run_id: selected.id }),
      accuracyRepo.listOverrideEffectiveness({ planning_run_id: selected.id }),
      accuracyRepo.listAnomalies({ planning_run_id: selected.id }),
      accuracyRepo.listSuggestions({ planning_run_id: selected.id }),
    ]);
    setRows(acc);
    setOverrideEff(ov);
    setAnomalies(an);
    setSuggestions(su);
  }, [selected]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [its, cats, custs, chs] = await Promise.all([
        wholesaleRepo.listItems(),
        wholesaleRepo.listCategories(),
        wholesaleRepo.listCustomers(),
        ecomRepo.listChannels(),
      ]);
      setItems(its);
      setCategories(cats);
      setCustomers(custs);
      setChannels(chs);
      await loadRuns();
      await loadRunData();
    } catch (e) {
      setToast({ text: "Load failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setLoading(false);
    }
  }, [loadRuns, loadRunData]);

  useEffect(() => { void refresh(); /* eslint-disable-line */ }, []);
  useEffect(() => { if (selected) void loadRunData(); /* eslint-disable-line */ }, [selectedRunId]);

  async function runPass() {
    if (!selected) { setToast({ text: "Pick a run first", kind: "error" }); return; }
    setBuilding(true);
    try {
      const r = await runAccuracyAndIntelligencePass(selected);
      setToast({
        text: `Pass complete — ${r.accuracy_rows} accuracy · ${r.override_rows} overrides · ${r.anomalies} anomalies · ${r.suggestions} suggestions`,
        kind: "success",
      });
      await loadRunData();
    } catch (e) {
      setToast({ text: "Pass failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setBuilding(false);
    }
  }

  async function acceptSuggestion(id: string) {
    try {
      await accuracyRepo.markSuggestion(id, true);
      await loadRunData();
      setToast({ text: "Suggestion accepted", kind: "success" });
    } catch (e) {
      setToast({ text: "Couldn't accept — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    }
  }
  async function ignoreSuggestion(id: string) {
    try {
      await accuracyRepo.markSuggestion(id, false);
      await loadRunData();
    } catch (e) {
      setToast({ text: "Couldn't ignore — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    }
  }

  return (
    <div style={S.app}>
      <div style={S.nav}>
        <div style={S.navLeft}>
          <div style={S.navLogo}>IP</div>
          <div>
            <div style={S.navTitle}>Demand & Inventory Planning</div>
            <div style={S.navSub}>Accuracy & AI co-pilot · Phase 5</div>
          </div>
        </div>
        <div style={S.navRight}>
          <a href="/planning/wholesale" style={{ ...S.btnSecondary, textDecoration: "none" }}>Wholesale</a>
          <a href="/planning/ecom" style={{ ...S.btnSecondary, textDecoration: "none" }}>Ecom</a>
          <a href="/planning/supply" style={{ ...S.btnSecondary, textDecoration: "none" }}>Supply</a>
          <a href="/planning/scenarios" style={{ ...S.btnSecondary, textDecoration: "none" }}>Scenarios →</a>
          <a href="/planning/data-quality" style={{ ...S.btnSecondary, textDecoration: "none" }}>DQ</a>
          <a href="/" style={{ ...S.btnSecondary, textDecoration: "none" }}>Back to PLM</a>
        </div>
      </div>

      <div style={S.content}>
        <div style={{ ...S.card, marginBottom: 12 }}>
          <div style={S.toolbar}>
            <strong style={{ color: PAL.text, fontSize: 14 }}>Planning run</strong>
            <select style={S.select} value={selectedRunId ?? ""} onChange={(e) => setSelectedRunId(e.target.value)}>
              <option value="">— pick —</option>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {r.planning_scope} · {r.status} · {formatDate(r.horizon_start)}
                </option>
              ))}
            </select>
            <button style={S.btnPrimary} onClick={runPass} disabled={building || !selected}>
              {building ? "Running pass…" : "Run accuracy + intelligence pass"}
            </button>
            <span style={{ color: PAL.textMuted, fontSize: 12 }}>
              Scores system vs final vs actual, detects anomalies, emits suggestions.
            </span>
          </div>
        </div>

        <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
          <TabButton active={tab === "accuracy"} onClick={() => setTab("accuracy")}>Accuracy ({rows.length})</TabButton>
          <TabButton active={tab === "overrides"} onClick={() => setTab("overrides")}>Overrides ({overrideEff.length})</TabButton>
          <TabButton active={tab === "anomalies"} onClick={() => setTab("anomalies")}>Anomalies ({anomalies.length})</TabButton>
          <TabButton active={tab === "suggestions"} onClick={() => setTab("suggestions")}>
            Suggestions ({suggestions.filter((s) => s.accepted_flag == null).length}/{suggestions.length})
          </TabButton>
          <TabButton active={tab === "ai_demand"} onClick={() => setTab("ai_demand")}>
            AI Demand ✦
          </TabButton>
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: PAL.textMuted }}>Loading…</div>
        ) : (
          <>
            {tab === "accuracy" && (
              <ForecastAccuracyDashboard rows={rows} skuCodeById={skuCodeById} categoryNameById={categoryNameById} customerNameById={customerNameById} channelNameById={channelNameById} />
            )}
            {tab === "overrides" && (
              <OverrideEffectivenessPanel rows={overrideEff} skuCodeById={skuCodeById} />
            )}
            {tab === "anomalies" && (
              <AnomalyQueue anomalies={anomalies} skuCodeById={skuCodeById} />
            )}
            {tab === "suggestions" && (
              <AISuggestionPanel
                suggestions={suggestions}
                skuCodeById={skuCodeById}
                onAccept={acceptSuggestion}
                onIgnore={ignoreSuggestion}
              />
            )}
            {tab === "ai_demand" && (
              <AIDemandPanel
                planningRunId={selectedRunId}
                onToast={(t) => setToast(t)}
              />
            )}
          </>
        )}
      </div>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
            style={{
              background: active ? PAL.panel : "transparent",
              border: `1px solid ${active ? PAL.accent : PAL.border}`,
              color: active ? PAL.text : PAL.textDim,
              borderRadius: 8,
              padding: "8px 14px",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}>
      {children}
    </button>
  );
}
