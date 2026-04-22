import { useEffect, useState } from "react";
import { supabaseVendor } from "./supabaseVendor";

interface Report {
  id: string;
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
  esg_score?: EsgScore | null;
}
interface EsgScore {
  environmental_score: number;
  social_score: number;
  governance_score: number;
  overall_score: number;
  period_start: string;
  period_end: string;
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

async function token() {
  const { data: { session } } = await supabaseVendor.auth.getSession();
  return session?.access_token || "";
}
async function api(path: string, init: RequestInit = {}) {
  const t = await token();
  return fetch(path, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${t}` } });
}

export default function VendorSustainability() {
  const [rows, setRows] = useState<Report[]>([]);
  const [latest, setLatest] = useState<EsgScore | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const [rReports, rEsg] = await Promise.all([api("/api/vendor/sustainability"), api("/api/vendor/esg-score")]);
      if (!rReports.ok) throw new Error(await rReports.text());
      const d = await rReports.json() as { rows: Report[] };
      setRows(d.rows || []);
      if (rEsg.ok) setLatest(((await rEsg.json()) as { latest: EsgScore | null }).latest);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  return (
    <div style={{ color: C.text, padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Sustainability & ESG</h2>
          <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>Submit annual sustainability reports. An ESG score is generated when approved.</div>
        </div>
        <button onClick={() => setFormOpen(true)} style={btnPrimary}>+ New report</button>
      </div>

      {latest && <EsgScoreCard score={latest} />}

      {loading ? <div style={{ color: C.textMuted }}>Loading…</div>
      : err ? <div style={{ color: C.danger }}>Error: {err}</div>
      : rows.length === 0 ? (
        <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>
          No reports submitted yet.
        </div>
      ) : (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", marginTop: latest ? 14 : 0 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 130px 130px 120px", padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
            <div>Period</div><div>Submitted</div><div>Status</div><div>ESG overall</div><div>Reviewed</div>
          </div>
          {rows.map((r) => (
            <div key={r.id} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 130px 130px 120px", padding: "10px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center" }}>
              <div>{r.reporting_period_start} → {r.reporting_period_end}</div>
              <div style={{ color: C.textSub }}>{new Date(r.submitted_at).toLocaleDateString()}</div>
              <div><StatusChip status={r.status} /></div>
              <div style={{ fontWeight: 700 }}>{r.esg_score ? r.esg_score.overall_score.toFixed(0) : "—"}</div>
              <div style={{ color: C.textMuted, fontSize: 11 }}>{r.reviewed_at ? new Date(r.reviewed_at).toLocaleDateString() : "—"}</div>
              {r.status === "rejected" && r.rejection_reason && (
                <div style={{ gridColumn: "1 / -1", fontSize: 11, color: C.danger, marginTop: 4 }}>Rejection reason: {r.rejection_reason}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {formOpen && <ReportFormModal onClose={() => setFormOpen(false)} onSubmitted={() => { setFormOpen(false); void load(); }} />}
    </div>
  );
}

function EsgScoreCard({ score }: { score: EsgScore }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 14, marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Latest ESG score · {score.period_start} → {score.period_end}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr 1fr", gap: 14, alignItems: "center", marginTop: 10 }}>
        <div>
          <div style={{ fontSize: 44, fontWeight: 800 }}>{Number(score.overall_score).toFixed(0)}</div>
          <div style={{ fontSize: 11, color: C.textMuted }}>OVERALL</div>
        </div>
        <ScorePart label="Environmental" value={score.environmental_score} color={C.success} />
        <ScorePart label="Social" value={score.social_score} color={C.primary} />
        <ScorePart label="Governance" value={score.governance_score} color={C.warn} />
      </div>
    </div>
  );
}
function ScorePart({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{Number(value).toFixed(0)}</div>
      <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
    </div>
  );
}

function ReportFormModal({ onClose, onSubmitted }: { onClose: () => void; onSubmitted: () => void }) {
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [s1, setS1] = useState(""); const [s2, setS2] = useState(""); const [s3, setS3] = useState("");
  const [renew, setRenew] = useState(""); const [waste, setWaste] = useState(""); const [water, setWater] = useState("");
  const [certs, setCerts] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setErr(null);
    if (!periodStart || !periodEnd) { setErr("Period start and end are required."); return; }
    setSaving(true);
    try {
      let fileUrl: string | null = null;
      if (file) {
        if (file.size > 20 * 1024 * 1024) throw new Error("File exceeds 20MB limit.");
        const { data: userRes } = await supabaseVendor.auth.getUser();
        const { data: vu } = await supabaseVendor.from("vendor_users").select("vendor_id").eq("auth_id", userRes.user!.id).maybeSingle();
        const vendorId = (vu as { vendor_id: string } | null)?.vendor_id;
        if (!vendorId) throw new Error("Not linked to a vendor.");
        const docId = crypto.randomUUID();
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const path = `${vendorId}/sustainability/${docId}/${safeName}`;
        const up = await supabaseVendor.storage.from("vendor-docs").upload(path, file, { cacheControl: "3600", upsert: false, contentType: file.type });
        if (up.error) throw up.error;
        fileUrl = path;
      }

      const body = {
        reporting_period_start: periodStart, reporting_period_end: periodEnd,
        scope1_emissions: s1 || null, scope2_emissions: s2 || null, scope3_emissions: s3 || null,
        renewable_energy_pct: renew || null, waste_diverted_pct: waste || null, water_usage_liters: water || null,
        certifications: certs.split(",").map((s) => s.trim()).filter(Boolean),
        report_file_url: fileUrl,
      };
      const r = await api("/api/vendor/sustainability", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await r.text());
      onSubmitted();
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modal, width: 600 }}>
        <h3 style={{ margin: "0 0 14px", fontSize: 18 }}>Submit sustainability report</h3>
        {err && <div style={{ color: C.danger, marginBottom: 10 }}>{err}</div>}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Row label="Period start"><input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} style={inp} /></Row>
          <Row label="Period end"><input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} style={inp} /></Row>
          <Row label="Scope 1 emissions (tCO2e)"><input type="number" value={s1} onChange={(e) => setS1(e.target.value)} style={inp} /></Row>
          <Row label="Scope 2 emissions (tCO2e)"><input type="number" value={s2} onChange={(e) => setS2(e.target.value)} style={inp} /></Row>
          <Row label="Scope 3 emissions (tCO2e)"><input type="number" value={s3} onChange={(e) => setS3(e.target.value)} style={inp} /></Row>
          <Row label="Water usage (L)"><input type="number" value={water} onChange={(e) => setWater(e.target.value)} style={inp} /></Row>
          <Row label="Renewable energy %"><input type="number" min="0" max="100" value={renew} onChange={(e) => setRenew(e.target.value)} style={inp} /></Row>
          <Row label="Waste diverted %"><input type="number" min="0" max="100" value={waste} onChange={(e) => setWaste(e.target.value)} style={inp} /></Row>
          <div style={{ gridColumn: "1 / -1" }}>
            <Row label="Certifications (comma separated)"><input value={certs} onChange={(e) => setCerts(e.target.value)} placeholder="ISO14001, B-Corp, SA8000" style={inp} /></Row>
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <Row label="Report PDF"><input type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] || null)} style={{ ...inp, padding: 6 }} /></Row>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={() => void save()} disabled={saving} style={btnPrimary}>{saving ? "Submitting…" : "Submit"}</button>
        </div>
      </div>
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const color = status === "approved" ? C.success : status === "rejected" ? C.danger : status === "under_review" ? C.warn : C.textSub;
  return <span style={{ fontSize: 10, color: "#fff", background: color, padding: "2px 8px", borderRadius: 10, fontWeight: 700, textTransform: "uppercase" }}>{status.replace("_", " ")}</span>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const inp = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.bg, color: C.text, fontSize: 13, boxSizing: "border-box" } as const;
const btnPrimary = { padding: "8px 14px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "6px 12px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" } as const;
const overlay = { position: "fixed" as const, inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 };
const modal = { background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 22, maxWidth: "92vw", maxHeight: "90vh", overflowY: "auto" as const, color: C.text };
