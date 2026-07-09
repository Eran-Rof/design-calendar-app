// src/tanda/components/SegmentGLDrillModal.tsx
//
// Drill-through Phase 2 — Segment P&L cell → the GL accounts behind it.
//
// The Segment P&L reads the sales sub-ledger; the GL carries the same sales
// as ROUTED daily bridge JEs (revenue 4005-4012 / COGS twins per
// revenueRouting). This modal calls /api/internal/segment-pl/gl-drill with the
// cell's column filters and lists each mapped GL account with:
//   sub-ledger $ (this cell's share) vs GL posted $ (the account's full net).
// Accounts flagged "shared" also receive sales from OTHER segments — an exact
// cell-to-GL tie is only expected on unshared accounts (and only for periods
// the routed backfill has posted).
//
// Each account row jumps into the existing GLDetailModal (account × range ×
// ACCRUAL) — from there Phase 1 reaches the JE and its source document.

import { useEffect, useState } from "react";
import ExportButton from "../exports/ExportButton";
import type { ExportColumn } from "../exports/useTableExport";
import GLDetailModal, { type GLDetailTarget } from "./GLDetailModal";

export type SegmentGLDrillTarget = {
  colLabel: string;                       // "Private Label", "Total", ...
  measure: "net_sales" | "cogs";
  measureLabel: string;                   // "Net Sales" | "COGS" | "Net Sales — Women"
  from: string;
  to: string;
  filters: { brands: string[]; channels: string[]; stores: string[]; genders: string[] };
};

type AccountRow = {
  account_id: string | null;
  code: string;
  name: string | null;
  account_type: string | null;
  subledger_amount: number;   // dollars
  gl_debit_cents: number;
  gl_credit_cents: number;
  gl_net_cents: number;
  shared: boolean;
};

const C = {
  card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", warn: "#F59E0B",
};

const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13,
};
const tdNum: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

function fmtDollars(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v) || v === 0) return "—";
  const neg = v < 0;
  return `${neg ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtCentsAsDollars(c: number | null | undefined): string {
  return fmtDollars(Number(c ?? 0) / 100);
}

export default function SegmentGLDrillModal({
  target,
  onClose,
}: {
  target: SegmentGLDrillTarget;
  onClose: () => void;
}) {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [subledgerTotal, setSubledgerTotal] = useState(0);
  const [glTotalCents, setGlTotalCents] = useState(0);
  const [cogsUnknown, setCogsUnknown] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [glTarget, setGlTarget] = useState<GLDetailTarget | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const p = new URLSearchParams();
        p.set("from", target.from);
        p.set("to", target.to);
        p.set("measure", target.measure);
        if (target.filters.brands.length) p.set("brands", target.filters.brands.join(","));
        if (target.filters.channels.length) p.set("channels", target.filters.channels.join(","));
        if (target.filters.stores.length) p.set("stores", target.filters.stores.join(","));
        if (target.filters.genders.length) p.set("genders", target.filters.genders.join(","));
        const r = await fetch(`/api/internal/segment-pl/gl-drill?${p.toString()}`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        const data = await r.json();
        if (cancelled) return;
        setAccounts((data.accounts || []) as AccountRow[]);
        setSubledgerTotal(Number(data.subledger_total || 0));
        setGlTotalCents(Number(data.gl_total_cents || 0));
        setCogsUnknown(!!data.cogs_unknown);
      } catch (e: unknown) {
        if (!cancelled) { setErr(e instanceof Error ? e.message : String(e)); setAccounts([]); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [target.from, target.to, target.measure, target.filters]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const exportColumns: ExportColumn<Record<string, unknown>>[] = [
    { key: "code",              header: "Account" },
    { key: "name",              header: "Name" },
    { key: "subledger_amount",  header: "Sub-ledger (this segment)", format: "number" },
    { key: "gl_net_cents",      header: "GL Posted (account net)", format: "currency_cents" },
    { key: "shared",            header: "Shared with other segments" },
  ];

  return (
    <>
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 1000, padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(880px, 95vw)", maxHeight: "90vh", overflowY: "auto",
          boxSizing: "border-box",
          background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 12,
          padding: 20, color: C.text,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 18 }}>
              GL behind — {target.colLabel} · {target.measureLabel}
            </h3>
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>
              range: <strong style={{ color: C.textSub }}>{target.from} → {target.to}</strong>
              <span style={{ marginLeft: 10 }}>basis: <strong style={{ color: C.textSub }}>ACCRUAL</strong></span>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent", color: C.textMuted, border: `1px solid ${C.cardBdr}`,
              borderRadius: 6, cursor: "pointer", fontSize: 14, padding: "4px 10px",
            }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
          <ExportButton
            rows={accounts as unknown as Array<Record<string, unknown>>}
            filename={`segment-gl-${target.colLabel.replace(/[^A-Za-z0-9-]/g, "_")}-${target.measure}-${target.from}-to-${target.to}`}
            sheetName="Segment GL Drill"
            columns={exportColumns}
          />
        </div>

        {err && (
          <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
            Error: {err}
          </div>
        )}

        <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden" }}>
          {loading ? (
            <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
          ) : accounts.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
              No sales in this cell for the selected range.
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>GL Account</th>
                  <th style={{ ...th, textAlign: "right" }}>Sub-ledger (this segment)</th>
                  <th style={{ ...th, textAlign: "right" }}>GL Posted (account net)</th>
                  <th style={{ ...th, width: 90 }}>Coverage</th>
                  <th style={{ ...th, width: 60, textAlign: "center" }}>GL</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr
                    key={a.code}
                    onDoubleClick={a.account_id ? () => setGlTarget({
                      accountId: a.account_id as string, code: a.code, name: a.name,
                      accountType: a.account_type, from: target.from, to: target.to, basis: "ACCRUAL",
                    }) : undefined}
                    style={{ cursor: a.account_id ? "pointer" : "default" }}
                    title={a.account_id ? "Double-click to open the account's GL detail" : undefined}
                  >
                    <td style={td}>
                      <span style={{ fontFamily: "SFMono-Regular, Menlo, monospace" }}>{a.code}</span>
                      <span style={{ color: C.textSub, marginLeft: 8 }}>{a.name || "—"}</span>
                    </td>
                    <td style={tdNum}>{fmtDollars(a.subledger_amount)}</td>
                    <td style={tdNum}>{fmtCentsAsDollars(a.gl_net_cents)}</td>
                    <td style={{ ...td, fontSize: 11, color: a.shared ? C.warn : C.textMuted }}>
                      {a.shared ? "shared" : "exclusive"}
                    </td>
                    <td style={{ ...td, textAlign: "center", padding: "4px 6px" }}>
                      {a.account_id && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setGlTarget({
                              accountId: a.account_id as string, code: a.code, name: a.name,
                              accountType: a.account_type, from: target.from, to: target.to, basis: "ACCRUAL",
                            });
                          }}
                          title="Open the account's GL detail for this range"
                          aria-label="Open GL detail"
                          style={{
                            background: "transparent", color: C.primary, border: `1px solid ${C.cardBdr}`,
                            borderRadius: 6, cursor: "pointer", fontSize: 13, lineHeight: 1, padding: "2px 6px",
                          }}
                        >
                          ↗
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: "#111827" }}>
                  <td style={{ ...td, fontWeight: 700, color: C.textSub }}>TOTAL ({accounts.length})</td>
                  <td style={{ ...tdNum, fontWeight: 700 }}>{fmtDollars(subledgerTotal)}</td>
                  <td style={{ ...tdNum, fontWeight: 700 }}>{fmtCentsAsDollars(glTotalCents)}</td>
                  <td style={td}></td>
                  <td style={td}></td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>

        <div style={{ fontSize: 11, color: C.textMuted, fontStyle: "italic", marginTop: 10 }}>
          Sub-ledger = this cell's share of sales history; GL Posted = the account's full posted net for the
          range (all segments). "Shared" accounts also receive sales from other segments, so the two columns
          only tie on "exclusive" accounts — and only for periods the routed revenue bridge has posted.
          {cogsUnknown && " Some sales in this cell have no cost in the sub-ledger; their COGS is excluded."}
          {" "}Double-click an account to walk its ledger → journal entry → source document.
        </div>
      </div>
    </div>

    {glTarget && <GLDetailModal target={glTarget} onClose={() => setGlTarget(null)} />}
    </>
  );
}
