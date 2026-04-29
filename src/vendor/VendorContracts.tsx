import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { TH } from "./theme";
import { supabaseVendor } from "./supabaseVendor";
import StatusBadge, { contractTone } from "./StatusBadge";
import { fmtDate, fmtMoney } from "./utils";

interface Contract {
  id: string;
  title: string;
  contract_type: string;
  status: string;
  start_date: string | null;
  end_date: string | null;
  value: number | null;
  currency: string;
  file_url: string | null;
  signed_file_url: string | null;
}

function statusLabel(s: string) {
  if (s === "under_review") return "Under review";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function VendorContracts() {
  const [rows, setRows] = useState<Contract[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const { data: { session } } = await supabaseVendor.auth.getSession();
        const token = session?.access_token;
        if (!token) throw new Error("Not authenticated");
        const r = await fetch("/api/vendor/contracts", { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) throw new Error(await r.text());
        const data = await r.json() as Contract[];
        if (!cancelled) setRows(data);
      } catch (e: unknown) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div style={{ color: TH.textMuted }}>Loading…</div>;
  if (err) return <div style={{ color: TH.primary, padding: 12, background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: "#FFFFFF", fontSize: 20 }}>Contracts</h2>
        <div style={{ color: "rgba(255,255,255,0.7)", fontSize: 13 }}>{rows.length} contract{rows.length === 1 ? "" : "s"}</div>
      </div>

      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, overflow: "hidden", boxShadow: `0 1px 2px ${TH.shadow}` }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.7fr 140px 140px 160px 160px 130px", padding: "10px 14px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.05 }}>
          <div>Title / Type</div>
          <div>Start</div>
          <div>End</div>
          <div>Value</div>
          <div>Status</div>
          <div style={{ textAlign: "right" }}>Action</div>
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No contracts yet.</div>
        ) : rows.map((c) => (
          <Link key={c.id} to={`/vendor/contracts/${c.id}`} style={{ display: "grid", gridTemplateColumns: "1.7fr 140px 140px 160px 160px 130px", padding: "12px 14px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center", textDecoration: "none", color: "inherit" }}>
            <div>
              <div style={{ fontWeight: 600, color: TH.text }}>{c.title}</div>
              <div style={{ fontSize: 11, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.04, marginTop: 2 }}>{c.contract_type.replace(/_/g, " ")}</div>
            </div>
            <div style={{ color: TH.textSub2 }}>{fmtDate(c.start_date)}</div>
            <div style={{ color: TH.textSub2 }}>{fmtDate(c.end_date)}</div>
            <div style={{ color: TH.textSub2 }}>{c.value != null ? fmtMoney(c.value) : "—"}</div>
            <div><StatusBadge label={statusLabel(c.status)} tone={contractTone(c.status)} /></div>
            <div style={{ textAlign: "right", color: TH.primary, fontSize: 12, fontWeight: 600 }}>
              {c.status === "sent" ? "Sign →" : "View →"}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
