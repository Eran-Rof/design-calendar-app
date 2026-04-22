import { useEffect, useState } from "react";

interface Row {
  id: string;
  vendor_id: string;
  vendor_name?: string | null;
  business_type: string[];
  certifying_body: string | null;
  certification_number: string | null;
  certification_expiry: string | null;
  certificate_file_url: string | null;
  verified: boolean;
  verified_at: string | null;
  verified_by: string | null;
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

export default function InternalDiversity() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [onlyPending, setOnlyPending] = useState(true);

  async function load() {
    setLoading(true); setErr(null);
    try {
      // Fetch the base table joined to vendors directly via the REST route
      const r = await fetch(`/api/internal/vendors/diversity${onlyPending ? "?pending=true" : ""}`);
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json() as { rows: Row[] };
      setRows(d.rows || []);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [onlyPending]);

  async function verify(vendorId: string) {
    const reviewer = prompt("Your name (for audit):") || "Internal";
    const r = await fetch(`/api/internal/diversity/${vendorId}/verify`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewer }),
    });
    if (!r.ok) { alert(await r.text()); return; }
    await load();
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Diversity profiles</h2>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Verify vendor-submitted diversity certifications.</div>
        </div>
        <label style={{ fontSize: 12, color: C.textSub, display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />
          Only unverified
        </label>
      </div>

      {loading ? <div style={{ color: C.textMuted }}>Loading…</div>
      : err ? <div style={{ color: C.danger }}>Error: {err}</div>
      : rows.length === 0 ? (
        <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>
          {onlyPending ? "No unverified profiles." : "No profiles submitted."}
        </div>
      ) : (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 2fr 1fr 120px 140px", padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
            <div>Vendor</div><div>Business types</div><div>Cert body / #</div><div>Expiry</div><div style={{ textAlign: "right" }}>Action</div>
          </div>
          {rows.map((r) => (
            <div key={r.id} style={{ display: "grid", gridTemplateColumns: "2fr 2fr 1fr 120px 140px", padding: "10px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center" }}>
              <div style={{ fontWeight: 600 }}>{r.vendor_name || r.vendor_id}</div>
              <div style={{ color: C.textSub, fontSize: 11 }}>{(r.business_type || []).join(", ") || "—"}</div>
              <div style={{ color: C.textSub, fontSize: 11 }}>{r.certifying_body || "—"} {r.certification_number ? `· ${r.certification_number}` : ""}</div>
              <div style={{ color: C.textMuted, fontSize: 11 }}>{r.certification_expiry || "—"}</div>
              <div style={{ textAlign: "right" }}>
                {r.verified
                  ? <span style={{ fontSize: 11, color: C.success, fontWeight: 700 }}>✓ Verified</span>
                  : <button onClick={() => void verify(r.vendor_id)} style={btnPrimary}>Verify</button>
                }
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const btnPrimary = { padding: "6px 12px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" } as const;
