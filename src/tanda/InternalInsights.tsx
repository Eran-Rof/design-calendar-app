import { useEffect, useState } from "react";

interface Insight {
  id: string;
  entity_id: string;
  vendor_id: string | null;
  type: string;
  title: string;
  summary: string | null;
  recommendation: string | null;
  confidence_pct: number | null;
  data_snapshot: Record<string, unknown> | null;
  status: "new" | "read" | "actioned" | "dismissed";
  generated_at: string;
  expires_at: string;
  vendor?: { id: string; name: string } | null;
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

const TYPE_LABEL: Record<string, string> = {
  cost_saving: "💸 Cost saving",
  risk_alert: "🚨 Risk alert",
  consolidation: "🔗 Consolidation",
  contract_renewal: "📝 Contract renewal",
  performance_trend: "📈 Performance trend",
  market_benchmark: "📊 Market benchmark",
};

const TYPES = Object.keys(TYPE_LABEL);

function typeColor(t: string) {
  if (t === "risk_alert") return C.danger;
  if (t === "cost_saving" || t === "market_benchmark") return C.warn;
  if (t === "performance_trend") return C.success;
  return C.primary;
}

export default function InternalInsights() {
  const [entities, setEntities] = useState<{ id: string; name: string }[]>([]);
  const [entityId, setEntityId] = useState("");
  const [rows, setRows] = useState<Insight[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("new");

  useEffect(() => {
    (async () => {
      const r = await fetch("/api/internal/entities?flat=true");
      if (r.ok) {
        const e = (await r.json()) as { id: string; name: string }[];
        setEntities(e);
        if (e.length && !entityId) setEntityId(e[0].id);
      }
    })();
  }, []);

  async function load() {
    if (!entityId) return;
    setLoading(true); setErr(null);
    try {
      const params = new URLSearchParams({ entity_id: entityId });
      if (typeFilter) params.set("type", typeFilter);
      if (statusFilter) params.set("status", statusFilter);
      const r = await fetch(`/api/internal/insights?${params.toString()}`);
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json() as { rows: Insight[] };
      setRows(d.rows || []);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [entityId, typeFilter, statusFilter]);

  async function setStatus(id: string, status: "read" | "actioned" | "dismissed") {
    const r = await fetch(`/api/internal/insights/${id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!r.ok) { alert(await r.text()); return; }
    await load();
  }

  async function regenerate() {
    if (!confirm("Run the insights generator for this entity now?")) return;
    const r = await fetch("/api/cron/insights-weekly", { method: "POST" });
    if (!r.ok) { alert(await r.text()); return; }
    await load();
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Insights</h2>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Generated weekly. Expire 30 days after creation if not actioned.</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select value={entityId} onChange={(e) => setEntityId(e.target.value)} style={selectSt}>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={selectSt}>
            <option value="">All types</option>
            {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectSt}>
            <option value="new">New</option>
            <option value="read">Read</option>
            <option value="actioned">Actioned</option>
            <option value="dismissed">Dismissed</option>
            <option value="">All</option>
          </select>
          <button onClick={() => void regenerate()} style={btnSecondary}>Regenerate now</button>
        </div>
      </div>

      {loading ? (
        <div style={{ color: C.textMuted }}>Loading…</div>
      ) : err ? (
        <div style={{ color: C.danger }}>Error: {err}</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>
          No insights match this filter.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(420px, 1fr))", gap: 14 }}>
          {rows.map((r) => (
            <div key={r.id} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderLeft: `4px solid ${typeColor(r.type)}`, borderRadius: 8, padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: typeColor(r.type), textTransform: "uppercase", letterSpacing: 0.5 }}>{TYPE_LABEL[r.type] || r.type}</div>
                <div style={{ fontSize: 10, color: C.textMuted }}>
                  {r.confidence_pct != null && `${Math.round(r.confidence_pct)}% confidence · `}
                  {new Date(r.generated_at).toLocaleDateString()}
                </div>
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, margin: "6px 0 4px" }}>{r.title}</div>
              {r.vendor?.name && <div style={{ fontSize: 11, color: C.textSub, marginBottom: 6 }}>Vendor: {r.vendor.name}</div>}
              {r.summary && <div style={{ fontSize: 12, color: C.textSub, marginBottom: 8 }}>{r.summary}</div>}
              {r.recommendation && (
                <div style={{ fontSize: 12, color: C.text, background: C.bg, border: `1px solid ${C.cardBdr}`, padding: 8, borderRadius: 6, marginBottom: 10 }}>
                  <span style={{ fontWeight: 700, color: C.primary }}>→ </span>{r.recommendation}
                </div>
              )}
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                {r.status === "new" && <button onClick={() => void setStatus(r.id, "read")} style={btnSecondary}>Mark read</button>}
                {r.status !== "actioned" && <button onClick={() => void setStatus(r.id, "actioned")} style={btnPrimary}>Action</button>}
                {r.status !== "dismissed" && <button onClick={() => void setStatus(r.id, "dismissed")} style={{ ...btnSecondary, color: C.danger }}>Dismiss</button>}
              </div>
              {r.status !== "new" && (
                <div style={{ fontSize: 10, color: C.textMuted, marginTop: 6, textTransform: "uppercase", fontWeight: 700 }}>Status: {r.status}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const selectSt = { padding: "6px 10px", background: C.card, border: `1px solid ${C.cardBdr}`, color: C.text, borderRadius: 6, fontSize: 13 } as const;
const btnPrimary = { padding: "6px 12px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "6px 12px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" } as const;
