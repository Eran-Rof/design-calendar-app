import { useEffect, useState } from "react";

interface Anomaly {
  id: string;
  vendor_id: string;
  type: string;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  status: string;
  detected_at: string;
  vendor?: { id: string; name: string };
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", danger: "#EF4444", warn: "#F59E0B", success: "#10B981",
};

function sevColor(s: string) {
  if (s === "critical") return C.danger;
  if (s === "high") return "#F97316";
  if (s === "medium") return C.warn;
  return C.textSub;
}

export default function InternalAnomalies() {
  const [rows, setRows] = useState<Anomaly[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [fType, setFType] = useState("");
  const [fSeverity, setFSeverity] = useState("");
  const [fStatus, setFStatus] = useState("open");

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams({ status: fStatus });
      if (fType) params.set("type", fType);
      if (fSeverity) params.set("severity", fSeverity);
      const r = await fetch(`/api/internal/anomalies?${params.toString()}`);
      if (!r.ok) throw new Error(await r.text());
      setRows((await r.json()) as Anomaly[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [fType, fSeverity, fStatus]);

  async function updateStatus(id: string, status: "dismissed" | "escalated" | "reviewed") {
    const reviewer = prompt("Your name for the audit log:");
    if (reviewer == null) return;
    const note = status !== "reviewed" ? prompt("Optional note:") : null;
    const r = await fetch(`/api/internal/anomalies/${id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, reviewed_by: reviewer || "Internal", note: note || undefined }),
    });
    if (!r.ok) { alert(await r.text()); return; }
    await load();
  }

  if (loading) return <div style={{ color: C.textMuted }}>Loading…</div>;
  if (err) return <div style={{ color: C.danger }}>Error: {err}</div>;

  return (
    <div style={{ color: C.text }}>
      <h2 style={{ margin: "0 0 16px", fontSize: 22 }}>Anomalies</h2>
      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <FilterSelect label="Type" value={fType} setValue={setFType} options={[
          ["", "All types"],
          ["duplicate_invoice", "Duplicate invoice"],
          ["price_variance", "Price variance"],
          ["unusual_volume", "Unusual volume"],
          ["late_pattern", "Late pattern"],
          ["compliance_gap", "Compliance gap"],
        ]} />
        <FilterSelect label="Severity" value={fSeverity} setValue={setFSeverity} options={[
          ["", "All severities"],
          ["critical", "Critical"],
          ["high", "High"],
          ["medium", "Medium"],
          ["low", "Low"],
        ]} />
        <FilterSelect label="Status" value={fStatus} setValue={setFStatus} options={[
          ["open", "Open"],
          ["reviewed", "Reviewed"],
          ["dismissed", "Dismissed"],
          ["escalated", "Escalated"],
        ]} />
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "160px 1.5fr 140px 110px 140px 220px", padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
          <div>Vendor</div>
          <div>Description</div>
          <div>Type</div>
          <div>Severity</div>
          <div>Detected</div>
          <div style={{ textAlign: "right" }}>Action</div>
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13 }}>No anomalies in this view.</div>
        ) : rows.map((a) => (
          <div key={a.id} style={{ display: "grid", gridTemplateColumns: "160px 1.5fr 140px 110px 140px 220px", padding: "12px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center" }}>
            <div style={{ fontWeight: 600 }}>{a.vendor?.name || a.vendor_id.slice(0, 8)}</div>
            <div style={{ color: C.textSub, fontSize: 12, lineHeight: 1.4 }}>{a.description}</div>
            <div style={{ color: C.textSub, fontSize: 12, textTransform: "capitalize" }}>{a.type.replace(/_/g, " ")}</div>
            <div style={{ color: sevColor(a.severity), fontWeight: 600, textTransform: "uppercase", fontSize: 12 }}>{a.severity}</div>
            <div style={{ color: C.textMuted, fontSize: 12 }}>{new Date(a.detected_at).toLocaleString()}</div>
            {a.status === "open" ? (
              <div style={{ textAlign: "right", display: "flex", gap: 6, justifyContent: "flex-end" }}>
                <button onClick={() => void updateStatus(a.id, "reviewed")} style={btnSecondary}>Mark reviewed</button>
                <button onClick={() => void updateStatus(a.id, "escalated")} style={{ ...btnSecondary, color: C.danger }}>Escalate</button>
                <button onClick={() => void updateStatus(a.id, "dismissed")} style={btnSecondary}>Dismiss</button>
              </div>
            ) : (
              <div style={{ textAlign: "right", color: C.textMuted, fontSize: 12, textTransform: "capitalize" }}>{a.status}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function FilterSelect({ label, value, setValue, options }: { label: string; value: string; setValue: (v: string) => void; options: [string, string][] }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 700, textTransform: "uppercase", marginBottom: 3 }}>{label}</div>
      <select value={value} onChange={(e) => setValue(e.target.value)} style={{ padding: "6px 10px", background: C.card, border: `1px solid ${C.cardBdr}`, color: C.text, borderRadius: 6, fontSize: 13 }}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
}

const btnSecondary = { padding: "4px 10px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 11, fontWeight: 600, fontFamily: "inherit" } as const;
