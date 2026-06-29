import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { TH } from "../theme";
import { supabaseVendor } from "../supabaseVendor";
import StatusBadge from "../StatusBadge";
import { fmtDate } from "../utils";

interface RfqRow {
  invitation: { id: string; status: string; invited_at: string; viewed_at: string | null; declined_at: string | null };
  rfq: { id: string; title: string; category: string | null; status: string; submission_deadline: string | null; delivery_required_by: string | null; awarded_to_vendor_id: string | null };
  quote: { id: string; status: string; total_price: number | null } | null;
  line_summary: { style: string | null; style_name: string | null; quantity: number | null; line_count: number } | null;
}

// Thousands separator for quantities (10000 → "10,000"); em-dash when absent.
const fmtQty = (n: number | null | undefined) => (n == null ? "—" : Number(n).toLocaleString("en-US"));

// Shared column template (header + rows stay aligned). The table can get wide
// with the added Style / Style name / Qty / Due columns, so it lives inside a
// horizontal scroller with this min-width.
const GRID = "1.6fr 110px 1fr 90px 120px 110px 120px 80px";
const GRID_MIN = 990;

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
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  function toggleSort(k: string) {
    setSortKey((prev) => (prev === k ? (sortDir === "asc" ? k : null) : k));
    setSortDir((prev) => (sortKey === k && prev === "asc" ? "desc" : "asc"));
  }

  async function load() {
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
  }

  // Initial fetch.
  useEffect(() => { void load(); }, []);

  // Re-fetch whenever this tab regains visibility — picks up any RFQs
  // deleted or changed by the operator while the vendor had the tab open.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const visible = useMemo(() => (
    filter === "all" ? rows
    : filter === "open"   ? rows.filter((r) => r.invitation.status !== "declined" && !["awarded", "rejected"].includes(r.quote?.status || ""))
    : filter === "quoted" ? rows.filter((r) => r.quote?.status === "submitted" || r.quote?.status === "under_review")
    : filter === "won"    ? rows.filter((r) => r.quote?.status === "awarded")
    : rows
  ), [rows, filter]);

  const sorted = useMemo(() => {
    if (!sortKey) return visible;
    const dir = sortDir === "asc" ? 1 : -1;
    const scalar = (r: RfqRow): string | number | null => {
      const s = r.line_summary;
      switch (sortKey) {
        case "title": return r.rfq.title || null;
        case "style": return s?.style || null;
        case "style_name": return s?.style_name || null;
        case "qty": return s?.quantity == null ? null : Number(s.quantity);
        case "category": return r.rfq.category || null;
        case "due": return r.rfq.delivery_required_by || null;
        case "status": return badgeForRow(r).label || null;
        default: return null;
      }
    };
    const arr = [...visible];
    arr.sort((a, b) => {
      const va = scalar(a);
      const vb = scalar(b);
      const aEmpty = va == null || va === "";
      const bEmpty = vb == null || vb === "";
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1;
      if (bEmpty) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
    return arr;
  }, [visible, sortKey, sortDir]);

  if (loading) return <div style={{ color: "rgba(255,255,255,0.85)" }}>Loading RFQs…</div>;
  if (err) return <div style={{ color: TH.primary, padding: 12, background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>;

  return (
    <div>
      <h2 style={{ color: "#FFFFFF", fontSize: 20, marginTop: 0, marginBottom: 4 }}>RFQs</h2>
      <div style={{ color: "rgba(255,255,255,0.65)", fontSize: 13, marginBottom: 16 }}>Request for quote invitations</div>

      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {[["all", "All"], ["open", "Open"], ["quoted", "Quoted"], ["won", "Won"]].map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)} style={{ padding: "6px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", background: filter === k ? TH.primary : "rgba(255,255,255,0.14)", color: "#FFFFFF", border: `1px solid ${filter === k ? TH.primary : "rgba(255,255,255,0.3)"}` }}>
            {l}
          </button>
        ))}
      </div>

      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, overflowX: "auto" }}>
        <div style={{ minWidth: GRID_MIN }}>
          <div style={{ display: "grid", gridTemplateColumns: GRID, columnGap: 12, padding: "10px 14px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase" }}>
            <div onClick={() => toggleSort("title")} style={{ cursor: "pointer", userSelect: "none" }}>Title{sortKey === "title" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</div>
            <div onClick={() => toggleSort("style")} style={{ cursor: "pointer", userSelect: "none" }}>Style{sortKey === "style" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</div>
            <div onClick={() => toggleSort("style_name")} style={{ cursor: "pointer", userSelect: "none" }}>Style name{sortKey === "style_name" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</div>
            <div onClick={() => toggleSort("qty")} style={{ textAlign: "right", cursor: "pointer", userSelect: "none" }}>Qty{sortKey === "qty" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</div>
            <div onClick={() => toggleSort("category")} style={{ cursor: "pointer", userSelect: "none" }}>Category{sortKey === "category" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</div>
            <div onClick={() => toggleSort("due")} style={{ cursor: "pointer", userSelect: "none" }}>Due{sortKey === "due" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</div>
            <div onClick={() => toggleSort("status")} style={{ cursor: "pointer", userSelect: "none" }}>Status{sortKey === "status" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</div>
            <div style={{ textAlign: "right" }}></div>
          </div>
          {sorted.length === 0 ? (
            <div style={{ padding: 30, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No RFQs in this view.</div>
          ) : sorted.map((r) => {
            const b = badgeForRow(r);
            const s = r.line_summary;
            return (
              <Link key={r.rfq.id} to={`/vendor/rfqs/${r.rfq.id}`} style={{ display: "grid", gridTemplateColumns: GRID, columnGap: 12, padding: "12px 14px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center", textDecoration: "none", color: "inherit" }}>
                <div style={{ fontWeight: 600, color: TH.text }}>{r.rfq.title}</div>
                <div style={{ color: TH.textSub }}>{s?.style || "—"}</div>
                <div style={{ color: TH.textSub }}>{s?.style_name || "—"}</div>
                <div style={{ textAlign: "right", color: TH.textSub2 }}>{fmtQty(s?.quantity)}</div>
                <div style={{ color: TH.textSub2 }}>{r.rfq.category || "—"}</div>
                <div style={{ color: TH.textSub2 }}>{fmtDate(r.rfq.delivery_required_by)}</div>
                <div><StatusBadge label={b.label} tone={b.tone} /></div>
                <div style={{ textAlign: "right", color: TH.primary, fontSize: 12, fontWeight: 600 }}>Open →</div>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
