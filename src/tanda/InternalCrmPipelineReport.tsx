// src/tanda/InternalCrmPipelineReport.tsx
//
// Tangerine P8-3 — CRM Pipeline aggregate report (M25, arch §3 + §4).
// Renders 5 stage cards: count + total_cents + weighted_cents. Visual stage bar
// across the top showing flow. Optional owner / customer filter.
//
// Hits /api/internal/crm/pipeline-report.

import { useEffect, useMemo, useState } from "react";
import ExportButton from "./exports/ExportButton";
import SearchableSelect from "./components/SearchableSelect";
import { useEmployeeOptions } from "./hooks/useEmployeeOptions";
import { useSeqGuard } from "./hooks/useSeqGuard";

type Stage = "new" | "qualified" | "proposal" | "won" | "lost";

type StageBucket = {
  stage: Stage;
  count: number;
  total_value_cents: number;
  weighted_value_cents: number;
};

type PipelineReport = {
  stages: StageBucket[];
  total_count: number;
  total_value_cents: number;
  total_weighted_cents: number;
};

type CustomerLite = { id: string; code: string | null; name: string };

const C = {
  card: "#1E293B",
  cardBdr: "#334155",
  text: "#F1F5F9",
  textMuted: "#94A3B8",
  textSub: "#CBD5E1",
  primary: "#3B82F6",
};

const STAGE_ORDER: Stage[] = ["new", "qualified", "proposal", "won", "lost"];

const STAGE_COLOR: Record<Stage, { bg: string; color: string; bar: string }> = {
  new:        { bg: "#374151", color: "#d1d5db", bar: "#6b7280" },
  qualified:  { bg: "#1e3a8a", color: "#93c5fd", bar: "#3b82f6" },
  proposal:   { bg: "#78350f", color: "#fcd34d", bar: "#f59e0b" },
  won:        { bg: "#064e3b", color: "#6ee7b7", bar: "#10b981" },
  lost:       { bg: "#7f1d1d", color: "#fca5a5", bar: "#ef4444" },
};

const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
  colorScheme: "dark",
};
const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 11, color: C.textMuted, marginBottom: 4,
  textTransform: "uppercase", letterSpacing: 0.5,
};

function fmtMoney(cents: number | null | undefined): string {
  if (cents == null) return "$0";
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export default function InternalCrmPipelineReport() {
  const [data, setData] = useState<PipelineReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const { options: employeeOptions } = useEmployeeOptions();

  const [ownerFilter, setOwnerFilter] = useState<string>("");
  const [customerFilter, setCustomerFilter] = useState<string>("");
  const [customers, setCustomers] = useState<CustomerLite[]>([]);

  // Fetch-race guard: rapid owner/customer filter changes fire overlapping
  // load()s; only the latest request's result may be applied.
  const seqGuard = useSeqGuard();

  async function load() {
    const seq = seqGuard.begin();
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (ownerFilter)    params.set("owner_user_id", ownerFilter);
      if (customerFilter) params.set("customer_id", customerFilter);
      const url = `/api/internal/crm/pipeline-report${params.toString() ? "?" + params.toString() : ""}`;
      const r = await fetch(url);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const d: PipelineReport = await r.json();
      if (!seqGuard.isCurrent(seq)) return; // superseded by a newer load — drop stale result
      setData(d);
    } catch (e) {
      if (seqGuard.isCurrent(seq)) {
        setErr(e instanceof Error ? e.message : String(e));
        setData(null);
      }
    } finally {
      if (seqGuard.isCurrent(seq)) setLoading(false);
    }
  }

  async function loadCustomers() {
    try {
      const r = await fetch("/api/internal/customer-master?limit=5000");
      if (!r.ok) return;
      const j = await r.json();
      const list = Array.isArray(j) ? j : (j?.rows ?? []);
      setCustomers(list.map((c: { id: string; code?: string | null; customer_code?: string | null; name: string }) => ({
        id: c.id, code: c.code ?? c.customer_code ?? null, name: c.name,
      })));
    } catch { /* non-fatal */ }
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => { loadCustomers(); }, []);
  useEffect(() => {
    const t = setTimeout(() => { load(); }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerFilter, customerFilter]);

  // For the flow bar, scale to the max stage count so all 5 bars are
  // proportional. Won/lost are terminal stages so we still render them in the
  // bar — operator sees the full funnel.
  const maxCount = useMemo(() => {
    if (!data) return 0;
    return Math.max(1, ...data.stages.map((s) => s.count));
  }, [data]);

  const exportRows = data ? data.stages.map((s) => ({
    stage: s.stage,
    count: s.count,
    total_value_cents: s.total_value_cents,
    weighted_value_cents: s.weighted_value_cents,
  })) : [];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 14, gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: C.text }}>
          Pipeline Report
        </h2>
        <span style={{ color: C.textMuted, fontSize: 12 }}>
          Per-stage count + weighted value (M25)
        </span>
        <div style={{ flex: 1 }} />
        <ExportButton
          rows={exportRows as unknown as Array<Record<string, unknown>>}
          filename="crm-pipeline-report"
          sheetName="Pipeline"
          columns={[
            { key: "stage",                 header: "Stage" },
            { key: "count",                 header: "Count",          format: "number" },
            { key: "total_value_cents",     header: "Total Value",    format: "currency_cents" },
            { key: "weighted_value_cents",  header: "Weighted Value", format: "currency_cents" },
          ]}
        />
        <button type="button" onClick={load} style={btnSecondary} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 18 }}>
        <div style={{ minWidth: 240 }}>
          <label style={labelStyle}>Owner</label>
          <SearchableSelect
            value={ownerFilter || null}
            onChange={(v) => setOwnerFilter(v || "")}
            options={[{ value: "", label: "All" }, ...employeeOptions]}
            placeholder="All"
            emptyText="No matching employees"
          />
        </div>
        <div style={{ minWidth: 260 }}>
          <label style={labelStyle}>Customer</label>
          <SearchableSelect
            value={customerFilter || null}
            onChange={(v) => setCustomerFilter(v)}
            options={[
              { value: "", label: "All" },
              ...customers.map((c) => ({ value: c.id, label: (c.code ? `${c.code} — ` : "") + c.name })),
            ]}
            inputStyle={inputStyle}
          />
        </div>
      </div>

      {err && (
        <div style={{
          background: "#7f1d1d", color: "#fecaca", padding: "8px 12px",
          borderRadius: 6, marginBottom: 12, fontSize: 13,
        }}>{err}</div>
      )}

      {data && (
        <>
          {/* Flow bar across the top — visualizes count per stage. */}
          <div style={{
            background: C.card, border: `1px solid ${C.cardBdr}`,
            borderRadius: 10, padding: 16, marginBottom: 18,
          }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
              <h3 style={{ margin: 0, fontSize: 13, color: C.textMuted, textTransform: "uppercase", letterSpacing: 1 }}>
                Flow (by count)
              </h3>
              <div style={{ flex: 1 }} />
              <span style={{ color: C.textSub, fontSize: 12 }}>
                Total <strong style={{ color: C.text }}>{data.total_count}</strong> opps · {fmtMoney(data.total_value_cents)} ({fmtMoney(data.total_weighted_cents)} weighted)
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 110 }}>
              {STAGE_ORDER.map((s) => {
                const bucket = data.stages.find((x) => x.stage === s);
                const count = bucket?.count ?? 0;
                const palette = STAGE_COLOR[s];
                const pct = (count / maxCount) * 100;
                return (
                  <div key={s} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                    <div style={{ color: C.text, fontSize: 16, fontWeight: 600 }}>{count}</div>
                    <div style={{
                      width: "100%",
                      height: `${Math.max(2, pct)}%`,
                      background: palette.bar,
                      borderRadius: "4px 4px 0 0",
                      transition: "height 200ms ease",
                    }} />
                    <div style={{
                      fontSize: 11, color: palette.color, fontWeight: 600,
                      textTransform: "uppercase", letterSpacing: 0.5,
                    }}>{s}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Stage cards. */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
            {STAGE_ORDER.map((s) => {
              const bucket = data.stages.find((x) => x.stage === s) || {
                stage: s, count: 0, total_value_cents: 0, weighted_value_cents: 0,
              };
              const palette = STAGE_COLOR[s];
              return (
                <div key={s} style={{
                  background: C.card, border: `1px solid ${C.cardBdr}`,
                  borderRadius: 10, padding: 14,
                  borderTopColor: palette.bar, borderTopWidth: 3,
                }}>
                  <div style={{
                    display: "inline-block", padding: "2px 8px", borderRadius: 10,
                    background: palette.bg, color: palette.color,
                    fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5,
                    marginBottom: 10,
                  }}>{s}</div>
                  <div style={{ color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Opps</div>
                  <div style={{ color: C.text, fontSize: 22, fontWeight: 700, marginBottom: 8 }}>{bucket.count}</div>
                  <div style={{ color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Total</div>
                  <div style={{ color: C.text, fontSize: 14, fontWeight: 600, fontFamily: "monospace", marginBottom: 6 }}>
                    {fmtMoney(bucket.total_value_cents)}
                  </div>
                  <div style={{ color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Weighted</div>
                  <div style={{ color: palette.color, fontSize: 14, fontWeight: 600, fontFamily: "monospace" }}>
                    {fmtMoney(bucket.weighted_value_cents)}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {!data && !loading && !err && (
        <div style={{ color: C.textMuted, fontSize: 13 }}>No pipeline data.</div>
      )}
    </div>
  );
}
