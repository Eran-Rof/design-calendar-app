import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { TH } from "./theme";
import { supabaseVendor } from "./supabaseVendor";
import { fmtDate, fmtMoney } from "./utils";

interface InvoiceRow {
  id: string;
  invoice_number: string;
  po_id: string | null;
  invoice_date: string | null;
  due_date: string | null;
  total: number | null;
  currency: string;
  status: string;
  submitted_at: string;
  paid_at: string | null;
}

type Filter = "all" | "open" | "paid";

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  submitted:    { bg: "#FEF3C7", fg: "#92400E" },
  under_review: { bg: "#DBEAFE", fg: "#1E40AF" },
  approved:     { bg: "#D1FAE5", fg: "#065F46" },
  paid:         { bg: "#A7F3D0", fg: "#064E3B" },
  rejected:     { bg: "#FECACA", fg: "#991B1B" },
  disputed:     { bg: "#FED7AA", fg: "#9A3412" },
};

export default function InvoicesList() {
  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const { data, error } = await supabaseVendor
          .from("invoices")
          .select("id, invoice_number, po_id, invoice_date, due_date, total, currency, status, submitted_at, paid_at")
          .order("submitted_at", { ascending: false });
        if (error) throw error;
        setRows((data ?? []) as InvoiceRow[]);
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const stats = useMemo(() => {
    const totalOpen = rows
      .filter((r) => !["paid", "rejected"].includes(r.status))
      .reduce((acc, r) => acc + (Number(r.total) || 0), 0);
    const totalPaid = rows
      .filter((r) => r.status === "paid")
      .reduce((acc, r) => acc + (Number(r.total) || 0), 0);
    return {
      count: rows.length,
      open: rows.filter((r) => !["paid", "rejected"].includes(r.status)).length,
      paid: rows.filter((r) => r.status === "paid").length,
      totalOpen,
      totalPaid,
    };
  }, [rows]);

  const visible = useMemo(() => {
    if (filter === "open") return rows.filter((r) => !["paid", "rejected"].includes(r.status));
    if (filter === "paid") return rows.filter((r) => r.status === "paid");
    return rows;
  }, [rows, filter]);

  if (loading) return <div style={{ color: "#FFFFFF" }}>Loading invoices…</div>;

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
        <StatCard label="Total invoices" value={String(stats.count)} />
        <StatCard label="Outstanding" value={fmtMoney(stats.totalOpen)} sub={`${stats.open} open`} tone="warn" />
        <StatCard label="Paid" value={fmtMoney(stats.totalPaid)} sub={`${stats.paid} paid`} tone="ok" />
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 16, alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 6 }}>
          <Pill active={filter === "all"} onClick={() => setFilter("all")}>All ({rows.length})</Pill>
          <Pill active={filter === "open"} onClick={() => setFilter("open")}>Open ({stats.open})</Pill>
          <Pill active={filter === "paid"} onClick={() => setFilter("paid")}>Paid ({stats.paid})</Pill>
        </div>
        <Link
          to="/vendor/invoices/new"
          style={{ padding: "8px 14px", borderRadius: 6, background: TH.primary, color: "#FFFFFF", textDecoration: "none", fontWeight: 600, fontSize: 13, whiteSpace: "nowrap" }}
        >
          + Submit invoice
        </Link>
      </div>

      {err && (
        <div style={{ color: TH.primary, padding: "10px 12px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
          Error: {err}
        </div>
      )}

      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, overflow: "hidden", boxShadow: `0 1px 2px ${TH.shadow}` }}>
        <div style={{ display: "grid", gridTemplateColumns: "170px 120px 120px 140px 140px 1fr", padding: "10px 14px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.05 }}>
          <div>Invoice #</div>
          <div>Submitted</div>
          <div>Due</div>
          <div style={{ textAlign: "right" }}>Amount</div>
          <div>Status</div>
          <div style={{ textAlign: "right" }}>Paid</div>
        </div>
        {visible.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>
            {rows.length === 0 ? "No invoices yet. Click 'Submit invoice' to start." : "No invoices in this view."}
          </div>
        ) : visible.map((r) => {
          const c = STATUS_COLORS[r.status] ?? { bg: TH.surfaceHi, fg: TH.text };
          return (
            <Link
              key={r.id}
              to={`/vendor/invoices/${r.id}`}
              style={{ display: "grid", gridTemplateColumns: "170px 120px 120px 140px 140px 1fr", padding: "12px 14px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center", color: "inherit", textDecoration: "none", background: TH.surface }}
            >
              <div style={{ fontWeight: 600, color: TH.text, fontFamily: "Menlo, monospace" }}>{r.invoice_number}</div>
              <div style={{ color: TH.textSub2 }}>{fmtDate(r.submitted_at)}</div>
              <div style={{ color: TH.textSub2 }}>{fmtDate(r.due_date)}</div>
              <div style={{ color: TH.text, fontWeight: 600 }}>{fmtMoney(r.total ?? undefined)}</div>
              <div>
                <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 10, background: c.bg, color: c.fg, fontWeight: 600, textTransform: "capitalize" }}>
                  {r.status.replace("_", " ")}
                </span>
              </div>
              <div style={{ textAlign: "right", color: TH.textMuted, fontSize: 12 }}>
                {r.paid_at ? fmtDate(r.paid_at) : "—"}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "warn" | "ok" }) {
  const color = tone === "warn" ? TH.primary : tone === "ok" ? "#047857" : TH.text;
  return (
    <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, padding: "14px 16px", boxShadow: `0 1px 2px ${TH.shadow}` }}>
      <div style={{ fontSize: 11, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.05, fontWeight: 600, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: TH.textMuted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "6px 12px",
        borderRadius: 999,
        border: `1px solid ${active ? TH.primary : TH.border}`,
        background: active ? TH.primary : TH.surface,
        color: active ? "#FFFFFF" : TH.textSub,
        cursor: "pointer",
        fontSize: 12,
        fontWeight: 600,
        fontFamily: "inherit",
      }}
    >
      {children}
    </button>
  );
}
