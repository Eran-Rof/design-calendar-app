import { useEffect, useState } from "react";
import { TH } from "../utils/theme";
import { supabaseVendor } from "./supabaseVendor";
import StatusBadge, { bulkTone } from "./StatusBadge";
import { showAlert } from "./ui/AppDialog";

interface BulkOp {
  id: string;
  type: string;
  status: string;
  input_file_url: string | null;
  result_file_url: string | null;
  total_rows: number;
  success_count: number;
  failure_count: number;
  created_at: string;
  completed_at: string | null;
}

async function token() {
  const { data: { session } } = await supabaseVendor.auth.getSession();
  return session?.access_token || "";
}

function formatLocal(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function statusLabel(s: string): string { return s[0].toUpperCase() + s.slice(1); }

export default function VendorBulk() {
  const [rows, setRows] = useState<BulkOp[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function load(silent = false) {
    if (!silent) setLoading(true);
    try {
      const t = await token();
      const r = await fetch("/api/vendor/bulk", { headers: { Authorization: `Bearer ${t}` } });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json() as BulkOp[];
      setRows(data);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    const hasActive = rows.some((r) => r.status === "queued" || r.status === "processing");
    if (!hasActive) return;
    const t = setInterval(() => { setRefreshing(true); void load(true); }, 5000);
    return () => clearInterval(t);
  }, [rows]);

  async function downloadResult(opId: string) {
    try {
      const t = await token();
      const r = await fetch(`/api/vendor/bulk/${opId}`, { headers: { Authorization: `Bearer ${t}` } });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      if (data.result_download_url) window.open(data.result_download_url, "_blank");
      else await showAlert({ title: "Not ready", message: "Result not ready yet.", tone: "info" });
    } catch (e: unknown) {
      await showAlert({ title: "Download failed", message: e instanceof Error ? e.message : String(e), tone: "danger" });
    }
  }

  if (loading) return <div style={{ color: TH.textMuted }}>Loading…</div>;
  if (err) return <div style={{ color: TH.primary, padding: 12, background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: "#FFFFFF", fontSize: 20 }}>Bulk operations {refreshing && <span style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", marginLeft: 8 }}>refreshing…</span>}</h2>
      </div>

      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, overflow: "hidden", boxShadow: `0 1px 2px ${TH.shadow}` }}>
        <div style={{ display: "grid", gridTemplateColumns: "160px 180px 120px 100px 100px 100px 160px", padding: "10px 14px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.05 }}>
          <div>Type</div>
          <div>Uploaded</div>
          <div>Status</div>
          <div style={{ textAlign: "right" }}>Total</div>
          <div style={{ textAlign: "right" }}>Success</div>
          <div style={{ textAlign: "right" }}>Failed</div>
          <div style={{ textAlign: "right" }}>Result</div>
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No bulk operations yet. Upload via the Catalog or Purchase Orders pages.</div>
        ) : rows.map((o) => (
          <div key={o.id} style={{ display: "grid", gridTemplateColumns: "160px 180px 120px 100px 100px 100px 160px", padding: "12px 14px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center" }}>
            <div style={{ color: TH.text, fontWeight: 600, textTransform: "capitalize" }}>{o.type.replace(/_/g, " ")}</div>
            <div style={{ color: TH.textSub2 }}>{formatLocal(o.created_at)}</div>
            <div><StatusBadge label={statusLabel(o.status)} tone={bulkTone(o.status)} /></div>
            <div style={{ textAlign: "right", color: TH.textSub2 }}>{o.total_rows}</div>
            <div style={{ textAlign: "right", color: "#276749" }}>{o.success_count}</div>
            <div style={{ textAlign: "right", color: o.failure_count > 0 ? TH.primary : TH.textSub2 }}>{o.failure_count}</div>
            <div style={{ textAlign: "right" }}>
              {o.result_file_url ? (
                <button onClick={() => void downloadResult(o.id)} style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${TH.border}`, background: TH.surfaceHi, color: TH.text, cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>Download</button>
              ) : <span style={{ color: TH.textMuted, fontSize: 12 }}>—</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
