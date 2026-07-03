import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { TH } from "../theme";
import { supabaseVendor } from "../supabaseVendor";
import StatusBadge, { contractTone } from "../StatusBadge";
import { fmtDate, fmtMoney } from "../utils";

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
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  function toggleSort(k: string) {
    setSortKey((prev) => (prev === k ? (sortDir === "asc" ? k : null) : k));
    setSortDir((prev) => (sortKey === k && prev === "asc" ? "desc" : "asc"));
  }

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

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const dir = sortDir === "asc" ? 1 : -1;
    const scalar = (c: Contract): string | number | null => {
      switch (sortKey) {
        case "title": return c.title || null;
        case "start": return c.start_date || null;
        case "end": return c.end_date || null;
        case "value": return typeof c.value === "number" ? c.value : null;
        case "status": return statusLabel(c.status) || null;
        default: return null;
      }
    };
    const arr = [...rows];
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
  }, [rows, sortKey, sortDir]);

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
          <div onClick={() => toggleSort("title")} style={{ cursor: "pointer", userSelect: "none" }}>Title / Type{sortKey === "title" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</div>
          <div onClick={() => toggleSort("start")} style={{ cursor: "pointer", userSelect: "none" }}>Start{sortKey === "start" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</div>
          <div onClick={() => toggleSort("end")} style={{ cursor: "pointer", userSelect: "none" }}>End{sortKey === "end" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</div>
          <div onClick={() => toggleSort("value")} style={{ cursor: "pointer", userSelect: "none" }}>Value{sortKey === "value" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</div>
          <div onClick={() => toggleSort("status")} style={{ cursor: "pointer", userSelect: "none" }}>Status{sortKey === "status" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</div>
          <div style={{ textAlign: "right" }}>Action</div>
        </div>
        {sorted.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No contracts yet.</div>
        ) : sorted.map((c) => (
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
