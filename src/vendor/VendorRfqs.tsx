import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { TH } from "./theme";
import { supabaseVendor } from "./supabaseVendor";
import StatusBadge from "./StatusBadge";
import { fmtDate } from "./utils";

interface RfqRow {
  invitation: { id: string; status: string; invited_at: string; viewed_at: string | null; declined_at: string | null };
  rfq: { id: string; title: string; category: string | null; status: string; submission_deadline: string | null; awarded_to_vendor_id: string | null };
  quote: { id: string; status: string; total_price: number | null } | null;
}

async function token() {
  const { data: { session } } = await supabaseVendor.auth.getSession();
  return session?.access_token || "";
}

function badgeForRow(r: RfqRow): { label: string; tone: "info" | "warn" | "ok" | "muted" | "danger" } {
  if (r.invitation.status === "declined") return { label: "Declined", tone: "muted" };
  if (r.quote?.status === "awarded" || r.rfq.awarded_to_vendor_id && r.quote) return { label: "Awarded", tone: "ok" };
  if (r.quote?.status === "rejected") return { label: "Not awarded", tone: "muted" };
  if (r.quote?.status === "submitted" || r.quote?.status === "under_review") return { label: "Quote submitted", tone: "info" };
  if (r.invitation.status === "viewed") return { label: "Viewed", tone: "warn" };
  return { label: "Invited", tone: "warn" };
}

export default function VendorRfqs() {
  const [rows, setRows] = useState<RfqRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const t = await token();
        const r = await fetch("/api/vendor/rfqs", { headers: { Authorization: `Bearer ${t}` } });
        if (!r.ok) throw new Error(await r.text());
        setRows(await r.json() as RfqRow[]);
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div style={{ color: "rgba(255,255,255,0.85)" }}>Loading RFQs…</div>;
  if (err) return <div style={{ color: TH.primary, padding: 12, background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>;

  const visible = filter === "all" ? rows
    : filter === "open"   ? rows.filter((r) => r.invitation.status !== "declined" && !["awarded", "rejected"].includes(r.quote?.status || ""))
    : filter === "quoted" ? rows.filter((r) => r.quote?.status === "submitted" || r.quote?.status === "under_review")
    : filter === "won"    ? rows.filter((r) => r.quote?.status === "awarded")
    : rows;

  return (
    <div>
      <h2 style={{ color: "#FFFFFF", fontSize: 20, marginTop: 0, marginBottom: 16 }}>Request for quote invitations</h2>

      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {[["all", "All"], ["open", "Open"], ["quoted", "Quoted"], ["won", "Won"]].map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)} style={{ padding: "6px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", background: filter === k ? TH.primary : "rgba(255,255,255,0.14)", color: "#FFFFFF", border: `1px solid ${filter === k ? TH.primary : "rgba(255,255,255,0.3)"}` }}>
            {l}
          </button>
        ))}
      </div>

      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 140px 140px 140px 130px", padding: "10px 14px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase" }}>
          <div>Title</div>
          <div>Category</div>
          <div>Deadline</div>
          <div>Status</div>
          <div style={{ textAlign: "right" }}></div>
        </div>
        {visible.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No RFQs in this view.</div>
        ) : visible.map((r) => {
          const b = badgeForRow(r);
          return (
            <Link key={r.rfq.id} to={`/vendor/rfqs/${r.rfq.id}`} style={{ display: "grid", gridTemplateColumns: "2fr 140px 140px 140px 130px", padding: "12px 14px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center", textDecoration: "none", color: "inherit" }}>
              <div style={{ fontWeight: 600, color: TH.text }}>{r.rfq.title}</div>
              <div style={{ color: TH.textSub2 }}>{r.rfq.category || "—"}</div>
              <div style={{ color: TH.textSub2 }}>{fmtDate(r.rfq.submission_deadline)}</div>
              <div><StatusBadge label={b.label} tone={b.tone} /></div>
              <div style={{ textAlign: "right", color: TH.primary, fontSize: 12, fontWeight: 600 }}>Open →</div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
