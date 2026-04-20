import { useEffect, useState } from "react";

interface Report {
  id: string;
  vendor_id: string;
  vendor?: { id: string; name: string } | null;
  reporting_period_start: string;
  reporting_period_end: string;
  scope1_emissions: number | null;
  scope2_emissions: number | null;
  scope3_emissions: number | null;
  renewable_energy_pct: number | null;
  waste_diverted_pct: number | null;
  water_usage_liters: number | null;
  certifications: string[];
  report_file_url: string | null;
  status: "submitted" | "under_review" | "approved" | "rejected";
  submitted_at: string;
  reviewed_at: string | null;
  rejection_reason: string | null;
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

export default function InternalSustainability() {
  const [rows, setRows] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState("submitted");
  const [selected, setSelected] = useState<Report | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/sustainability${status ? `?status=${status}` : ""}`);
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json() as { rows: Report[] };
      setRows(d.rows || []);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [status]);

  async function review(report: Report, action: "approved" | "rejected") {
    const reviewer = prompt("Your name (for audit):") || "Internal";
    let notes: string | null = null;
    if (action === "rejected") {
      notes = prompt("Rejection reason:");
      if (!notes) return;
    }
    const r = await fetch(`/api/internal/sustainability/${report.id}/review`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: action, notes, reviewer }),
    });
    if (!r.ok) { alert(await r.text()); return; }
    const result = await r.json();
    if (action === "approved" && result?.esg) {
      alert(`Approved. ESG overall score: ${Math.round(result.esg.overall || 0)}`);
    }
    setSelected(null);
    await load();
  }

  if (selected) return <ReportDetail report={selected} onBack={() => setSelected(null)} onReview={review} />;

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Sustainability reports</h2>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Review vendor submissions. Approval triggers ESG score calculation.</div>
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={selectSt}>
          <option value="submitted">Submitted</option>
          <option value="under_review">Under review</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="">All</option>
        </select>
      </div>

      {loading ? <div style={{ color: C.textMuted }}>Loading…</div>
      : err ? <div style={{ color: C.danger }}>Error: {err}</div>
      : rows.length === 0 ? (
        <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>Nothing in queue.</div>
      ) : (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1.5fr 130px 120px 1fr", padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
            <div>Vendor</div><div>Period</div><div>Status</div><div>Submitted</div><div style={{ textAlign: "right" }}>Action</div>
          </div>
          {rows.map((r) => (
            <div key={r.id} style={{ display: "grid", gridTemplateColumns: "1.5fr 1.5fr 130px 120px 1fr", padding: "10px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center" }}>
              <div style={{ fontWeight: 600 }}>{r.vendor?.name || r.vendor_id}</div>
              <div style={{ color: C.textSub }}>{r.reporting_period_start} → {r.reporting_period_end}</div>
              <div><StatusChip status={r.status} /></div>
              <div style={{ color: C.textMuted, fontSize: 11 }}>{new Date(r.submitted_at).toLocaleDateString()}</div>
              <div style={{ textAlign: "right" }}>
                <button onClick={() => setSelected(r)} style={btnSecondary}>Review</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ReportDetail({ report, onBack, onReview }: { report: Report; onBack: () => void; onReview: (r: Report, a: "approved" | "rejected") => void }) {
  return (
    <div style={{ color: C.text }}>
      <button onClick={onBack} style={{ ...btnSecondary, marginBottom: 10 }}>← Back</button>
      <h2 style={{ margin: 0, fontSize: 22 }}>{report.vendor?.name || report.vendor_id} · {report.reporting_period_start} → {report.reporting_period_end}</h2>
      <div style={{ margin: "6px 0 16px" }}><StatusChip status={report.status} /></div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 14 }}>
        <Metric label="Scope 1 (tCO2e)" value={report.scope1_emissions} />
        <Metric label="Scope 2 (tCO2e)" value={report.scope2_emissions} />
        <Metric label="Scope 3 (tCO2e)" value={report.scope3_emissions} />
        <Metric label="Renewable energy %" value={report.renewable_energy_pct} suffix="%" />
        <Metric label="Waste diverted %" value={report.waste_diverted_pct} suffix="%" />
        <Metric label="Water usage (L)" value={report.water_usage_liters} />
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 14, marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", marginBottom: 6 }}>Certifications</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {(report.certifications || []).length === 0
            ? <span style={{ color: C.textMuted, fontSize: 12 }}>None listed.</span>
            : report.certifications.map((c) => <span key={c} style={{ fontSize: 11, background: C.bg, border: `1px solid ${C.cardBdr}`, padding: "3px 8px", borderRadius: 10 }}>{c}</span>)}
        </div>
      </div>

      {report.report_file_url && (
        <div style={{ fontSize: 12, color: C.textSub, marginBottom: 14 }}>Report file: {report.report_file_url}</div>
      )}

      {report.status === "rejected" && report.rejection_reason && (
        <div style={{ background: "rgba(239,68,68,0.1)", border: `1px solid ${C.danger}`, borderRadius: 6, padding: 10, fontSize: 12, marginBottom: 14 }}>
          Rejection reason: {report.rejection_reason}
        </div>
      )}

      {(report.status === "submitted" || report.status === "under_review") && (
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={() => onReview(report, "rejected")} style={{ ...btnSecondary, color: C.danger }}>Reject</button>
          <button onClick={() => onReview(report, "approved")} style={{ ...btnPrimary, background: C.success }}>Approve</button>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, suffix = "" }: { label: string; value: number | null; suffix?: string }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 12 }}>
      <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 700, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{value == null ? "—" : `${Number(value).toLocaleString()}${suffix}`}</div>
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const color = status === "approved" ? C.success : status === "rejected" ? C.danger : status === "under_review" ? C.warn : C.textSub;
  return <span style={{ fontSize: 10, color: "#fff", background: color, padding: "2px 8px", borderRadius: 10, fontWeight: 700, textTransform: "uppercase" }}>{status.replace("_", " ")}</span>;
}

const selectSt = { padding: "6px 10px", background: C.card, border: `1px solid ${C.cardBdr}`, color: C.text, borderRadius: 6, fontSize: 13 } as const;
const btnPrimary = { padding: "8px 14px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "6px 12px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" } as const;
