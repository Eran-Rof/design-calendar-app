import { useEffect, useState } from "react";

interface Row {
  id: string;
  vendor_id: string;
  document_id: string | null;
  action: string;
  performed_by_type: "vendor" | "internal" | "system";
  performed_by: string | null;
  notes: string | null;
  created_at: string;
  vendor?: { id: string; name: string } | null;
  document?: { id: string; document_type_id: string; document_type?: { id: string; name: string; code: string } | null } | null;
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

const ACTIONS = ["uploaded", "reviewed", "approved", "rejected", "expired", "renewed", "requested"];

function actionColor(a: string) {
  if (a === "approved" || a === "renewed") return C.success;
  if (a === "rejected" || a === "expired") return C.danger;
  if (a === "requested") return C.warn;
  return C.primary;
}

export default function InternalComplianceAudit() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [action, setAction] = useState("");

  async function load() {
    setLoading(true); setErr(null);
    try {
      const params = new URLSearchParams();
      if (action) params.set("action", action);
      const r = await fetch(`/api/internal/compliance/audit-trail?${params.toString()}`);
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json() as { rows: Row[] };
      setRows(d.rows || []);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [action]);

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Compliance audit trail</h2>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Every upload, review, expiry, and automation action. Newest first.</div>
        </div>
        <select value={action} onChange={(e) => setAction(e.target.value)} style={selectSt}>
          <option value="">All actions</option>
          {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>

      {loading ? <div style={{ color: C.textMuted }}>Loading…</div>
      : err ? <div style={{ color: C.danger }}>Error: {err}</div>
      : rows.length === 0 ? (
        <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>
          No audit entries.
        </div>
      ) : (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "130px 1.5fr 1.5fr 130px 2fr 150px", padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
            <div>Action</div><div>Vendor</div><div>Document</div><div>By</div><div>Notes</div><div>When</div>
          </div>
          {rows.map((r) => (
            <div key={r.id} style={{ display: "grid", gridTemplateColumns: "130px 1.5fr 1.5fr 130px 2fr 150px", padding: "8px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 12, alignItems: "center" }}>
              <div><span style={{ fontSize: 10, color: "#fff", background: actionColor(r.action), padding: "2px 8px", borderRadius: 10, fontWeight: 700, textTransform: "uppercase" }}>{r.action}</span></div>
              <div>{r.vendor?.name || r.vendor_id}</div>
              <div style={{ color: C.textSub }}>{r.document?.document_type?.name || (r.document_id ? r.document_id.slice(0, 8) : "—")}</div>
              <div style={{ color: C.textMuted, fontSize: 11 }}>{r.performed_by_type}{r.performed_by ? ` · ${r.performed_by}` : ""}</div>
              <div style={{ color: C.textMuted, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.notes || "—"}</div>
              <div style={{ color: C.textMuted, fontSize: 11 }}>{new Date(r.created_at).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const selectSt = { padding: "6px 10px", background: C.card, border: `1px solid ${C.cardBdr}`, color: C.text, borderRadius: 6, fontSize: 13 } as const;
