// src/tanda/components/GLDetailModal.tsx
//
// Tangerine — reusable GL-account drill-down modal for financial reports.
//
// Given an account (id + code + name + type), a date window and a basis, this
// modal fetches /api/internal/gl-detail and renders the account's posted
// journal_entry_lines (date, JE, description, debit, credit, running balance)
// with totals — the same ledger the standalone GL Detail panel shows, scoped to
// exactly the report's selected range + basis.
//
// Used by the Income Statement, Trial Balance, and Balance Sheet panels: click
// (or double-click) an account row -> this modal opens pre-filtered.
//
// JE numbers / memos are resolved by the gl-detail RPC — no raw UUIDs surface.

import { useCallback, useEffect, useState } from "react";
import { fmtDateDisplay } from "../../utils/tandaTypes";
import ExportButton from "../exports/ExportButton";
import JEDetailModal, { type JEDetailSeed } from "./JEDetailModal";
import { notify } from "../../shared/ui/warn";

export type GLDetailTarget = {
  accountId: string;
  code: string | null;
  name: string | null;
  accountType?: string | null;
  from: string;
  to: string;
  basis: "ACCRUAL" | "CASH";
};

type Row = {
  posting_date: string;
  je_id: string;
  je_number: string | null;
  description: string | null;
  debit_cents: number | string;
  credit_cents: number | string;
  running_balance_cents: number | string;
  source_module: string | null;
  source_id: string | null;
};

const C = {
  card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", danger: "#EF4444",
};

const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
  position: "sticky", top: 0, zIndex: 2,
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13,
};
const tdNum: React.CSSProperties = {
  ...td, textAlign: "right", fontVariantNumeric: "tabular-nums",
};

function fmtCents(c: number | string | null | undefined): string {
  const n = Number(c ?? 0);
  if (!Number.isFinite(n) || n === 0) return "—";
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.trunc(abs / 100);
  const frac = abs - whole * 100;
  return `${neg ? "-" : ""}$${whole.toLocaleString()}.${String(frac).padStart(2, "0")}`;
}

function fmtBalanceCents(c: number | string | null | undefined): string {
  const n = Number(c ?? 0);
  if (!Number.isFinite(n)) return "$0.00";
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.trunc(abs / 100);
  const frac = abs - whole * 100;
  return `${neg ? "-" : ""}$${whole.toLocaleString()}.${String(frac).padStart(2, "0")}`;
}

export default function GLDetailModal({
  target,
  onClose,
}: {
  target: GLDetailTarget;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Click a ledger line -> open that line's full Journal Entry in
  // the shared JE detail/reverse modal. Seeded with the JE id + description from
  // the line; the JE modal self-fetches the rest. No raw UUID is shown.
  const [jeSeed, setJeSeed] = useState<JEDetailSeed | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      params.set("account_id", target.accountId);
      params.set("from", target.from);
      params.set("to", target.to);
      params.set("basis", target.basis);
      const r = await fetch(`/api/internal/gl-detail?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const data = await r.json();
      setRows((data.rows || []) as Row[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e)); setRows([]);
    } finally {
      setLoading(false);
    }
  }, [target.accountId, target.from, target.to, target.basis]);

  useEffect(() => { void load(); }, [load]);

  // Reverse a posted JE from the GL-detail drill (same flow as the JE module:
  // optional posting_date prompt -> POST /reverse -> reload the ledger).
  const reverseJE = useCallback(async (jeId: string) => {
    const answer = prompt(
      "Reverse this journal entry? Optionally enter a posting_date (YYYY-MM-DD), or leave blank for today:",
      "",
    );
    if (answer === null) return;
    try {
      const body: Record<string, unknown> = {};
      if (answer.trim() && /^\d{4}-\d{2}-\d{2}$/.test(answer.trim())) body.posting_date = answer.trim();
      const r = await fetch(`/api/internal/journal-entries/${jeId}/reverse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setJeSeed(null);
      await load();
    } catch (e: unknown) {
      notify(`Reverse failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }, [load]);

  // Close on Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const totals = rows.reduce(
    (acc, r) => {
      acc.debit += Number(r.debit_cents || 0);
      acc.credit += Number(r.credit_cents || 0);
      return acc;
    },
    { debit: 0, credit: 0 },
  );
  const netCents = totals.debit - totals.credit;

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
          width: "min(960px, 95vw)", maxHeight: "90vh", overflowY: "auto",
          boxSizing: "border-box",
          background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 12,
          padding: 20, color: C.text,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 18 }}>
              GL Detail — {target.code || ""}{target.code ? " · " : ""}{target.name || "Account"}
            </h3>
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>
              {target.accountType && <span style={{ marginRight: 10 }}>type: <strong style={{ color: C.textSub }}>{target.accountType}</strong></span>}
              <span style={{ marginRight: 10 }}>basis: <strong style={{ color: C.textSub }}>{target.basis}</strong></span>
              <span>range: <strong style={{ color: C.textSub }}>{target.from} → {target.to}</strong></span>
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
            rows={rows as unknown as Array<Record<string, unknown>>}
            filename={`gl-detail-${(target.code || target.accountId).replace(/[^A-Za-z0-9_-]/g, "_")}-${target.basis}-${target.from}-to-${target.to}`}
            sheetName="GL Detail"
            columns={[
              { key: "posting_date",  header: "Date",    format: "date" },
              { key: "je_number",     header: "JE" },
              { key: "description",   header: "Description" },
              { key: "debit_cents",   header: "Debit",   format: "currency_cents" },
              { key: "credit_cents",  header: "Credit",  format: "currency_cents" },
              { key: "running_balance_cents", header: "Balance", format: "currency_cents" },
              { key: "source_module", header: "Source Module" },
              { key: "source_id",     header: "Source ID" },
            ]}
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
          ) : rows.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
              No {target.basis} posted activity for this account between {target.from} and {target.to}.
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>Date</th>
                  <th style={th}>JE #</th>
                  <th style={th}>Description</th>
                  <th style={th}>Source</th>
                  <th style={{ ...th, textAlign: "right" }}>Debit</th>
                  <th style={{ ...th, textAlign: "right" }}>Credit</th>
                  <th style={{ ...th, textAlign: "right" }}>Running Balance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={`${r.je_id}-${r.posting_date}`}
                    onClick={() => setJeSeed({ id: r.je_id, je_number: r.je_number, description: r.description })}
                    style={{ cursor: "pointer" }}
                    title="Click to open the full journal entry"
                  >
                    <td style={td}>{fmtDateDisplay(r.posting_date)}</td>
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", whiteSpace: "nowrap", color: C.primary, fontWeight: 600 }}>{r.je_number || "—"}</td>
                    <td style={td}>{r.description || "—"}</td>
                    <td style={{ ...td, color: C.textMuted, fontSize: 11 }}>{r.source_module || "—"}</td>
                    <td style={tdNum}>{fmtCents(r.debit_cents)}</td>
                    <td style={tdNum}>{fmtCents(r.credit_cents)}</td>
                    <td style={{ ...tdNum, fontWeight: 600 }}>{fmtBalanceCents(r.running_balance_cents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: "#111827" }}>
                  <td style={{ ...td, fontWeight: 700, color: C.textSub }} colSpan={4}>TOTAL ({rows.length})</td>
                  <td style={{ ...tdNum, fontWeight: 700 }}>{fmtCents(totals.debit)}</td>
                  <td style={{ ...tdNum, fontWeight: 700 }}>{fmtCents(totals.credit)}</td>
                  <td style={{ ...tdNum, fontWeight: 700, color: netCents !== 0 ? C.text : C.textMuted }}>{fmtBalanceCents(netCents)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>
    </div>

    {jeSeed && (
      <JEDetailModal
        je={jeSeed}
        onClose={() => setJeSeed(null)}
        onReversed={() => { setJeSeed(null); void load(); }}
        onReverseClick={(full) => void reverseJE(full.id)}
      />
    )}
    </>
  );
}
