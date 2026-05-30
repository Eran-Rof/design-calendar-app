// src/tanda/InternalGLDetail.tsx
//
// Tangerine P7-7 — GL Detail by Account × Period panel (Reports menu group).
// Reads /api/internal/gl-detail?account_id=…&from=YYYY-MM-DD&to=YYYY-MM-DD.
//
// Account-picker dropdown loaded from /api/internal/gl-accounts. Date inputs
// hand-rolled in the Trial Balance style (T7 preset component will sweep these
// later).

import { useEffect, useState } from "react";
import ExportButton from "./exports/ExportButton";
import SearchableSelect from "./components/SearchableSelect";
import DateRangePresets from "./components/DateRangePresets.tsx";

type Account = {
  id: string;
  code: string | null;
  name: string | null;
  account_type: string | null;
  status?: string;
};

type Row = {
  posting_date: string;
  je_id: string;
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

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: `1px solid ${C.primary}`,
  padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600,
};
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
};
const selectStyle: React.CSSProperties = { ...inputStyle, width: 340 };
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

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoMinusDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// Read drill-down deep-link params from the current URL exactly once.
// COA panel sends `/tangerine?view=gl_detail&account_id=…&from=YYYY-MM-DD&to=YYYY-MM-DD`.
// Each param is validated; invalid values fall through to defaults rather
// than throwing so a botched URL still renders the standard panel.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function readDeepLink(search: string): { account_id?: string; from?: string; to?: string } {
  const out: { account_id?: string; from?: string; to?: string } = {};
  try {
    const p = new URLSearchParams(search);
    const aid = (p.get("account_id") || "").trim();
    if (UUID_RE.test(aid)) out.account_id = aid;
    const f = (p.get("from") || "").trim();
    if (ISO_DATE_RE.test(f)) out.from = f;
    const t = (p.get("to") || "").trim();
    if (ISO_DATE_RE.test(t)) out.to = t;
  } catch {
    // Malformed query — return empty so caller falls back to defaults.
  }
  return out;
}

export default function InternalGLDetail() {
  const initial = typeof window !== "undefined"
    ? readDeepLink(window.location.search)
    : {};

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState<string>(initial.account_id || "");
  const [fromDate, setFromDate] = useState<string>(initial.from || isoMinusDays(90));
  const [toDate, setToDate] = useState<string>(initial.to || todayISO());
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/internal/gl-accounts?limit=2000")
      .then((r) => r.json())
      .then((arr: Account[]) => {
        if (!Array.isArray(arr)) return;
        const active = arr
          .filter((a) => (a.status ?? "active") === "active")
          .sort((a, b) => (a.code || "").localeCompare(b.code || ""));
        setAccounts(active);
      })
      .catch(() => {});
  }, []);

  // Auto-load when arriving via deep link (COA balance click-through).
  // Fires once on mount only — operator interactions go through the Load
  // button as before so we don't surprise them with mid-edit refetches.
  useEffect(() => {
    if (initial.account_id) {
      void load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    if (!accountId) {
      setErr("Pick an account first");
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      params.set("account_id", accountId);
      params.set("from", fromDate);
      params.set("to", toDate);
      const r = await fetch(`/api/internal/gl-detail?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const data = await r.json();
      setRows((data.rows || []) as Row[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  const totals = rows.reduce(
    (acc, r) => {
      acc.debit += Number(r.debit_cents || 0);
      acc.credit += Number(r.credit_cents || 0);
      return acc;
    },
    { debit: 0, credit: 0 },
  );
  const netCents = totals.debit - totals.credit;

  const selectedAccount = accounts.find((a) => a.id === accountId) || null;

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>GL Detail</h2>
        <div style={{ fontSize: 11, color: C.textMuted }}>
          {rows.length} line{rows.length === 1 ? "" : "s"}
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
          Account
          <div style={{ width: 340 }}>
            <SearchableSelect
              value={accountId || null}
              onChange={(v) => setAccountId(v)}
              options={[
                { value: "", label: "— Pick account —" },
                ...accounts.map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })),
              ]}
              placeholder="— Pick account —"
            />
          </div>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
          From
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={{ ...inputStyle, width: 160 }} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
          To
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={{ ...inputStyle, width: 160 }} />
        </label>
        <DateRangePresets
          from={fromDate}
          to={toDate}
          onChange={(f, t) => { setFromDate(f); setToDate(t); }}
        />
        <button onClick={() => void load()} style={btnPrimary} disabled={loading || !accountId}>
          {loading ? "Loading…" : "Load"}
        </button>
        <ExportButton
          rows={rows as unknown as Array<Record<string, unknown>>}
          filename={selectedAccount
            ? `gl-detail-${(selectedAccount.code || selectedAccount.id).replace(/[^A-Za-z0-9_-]/g, "_")}`
            : "gl-detail"}
          sheetName="GL Detail"
          columns={[
            { key: "posting_date",  header: "Date",          format: "date" },
            { key: "je_id",         header: "JE" },
            { key: "description",   header: "Description" },
            { key: "debit_cents",   header: "Debit",         format: "currency_cents" },
            { key: "credit_cents",  header: "Credit",        format: "currency_cents" },
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

      {selectedAccount && (
        <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 8 }}>
          Account: <strong style={{ color: C.text }}>{selectedAccount.code} — {selectedAccount.name}</strong>
          {selectedAccount.account_type && <span style={{ marginLeft: 6 }}>({selectedAccount.account_type})</span>}
        </div>
      )}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, maxHeight: "calc(100vh - 320px)", overflowY: "auto" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : !accountId ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Pick an account and click Load.</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
            No ACCRUAL posted activity for this account between {fromDate} and {toDate}.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Date</th>
                <th style={th}>Description</th>
                <th style={th}>Source</th>
                <th style={{ ...th, textAlign: "right" }}>Debit</th>
                <th style={{ ...th, textAlign: "right" }}>Credit</th>
                <th style={{ ...th, textAlign: "right" }}>Running Balance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.je_id}-${r.posting_date}`}>
                  <td style={td}>{r.posting_date}</td>
                  <td style={td}>{r.description || "—"}</td>
                  <td style={{ ...td, color: C.textMuted, fontSize: 11 }}>
                    {r.source_module}{r.source_id ? ` · ${r.source_id}` : ""}
                  </td>
                  <td style={tdNum}>{fmtCents(r.debit_cents)}</td>
                  <td style={tdNum}>{fmtCents(r.credit_cents)}</td>
                  <td style={{ ...tdNum, fontWeight: 600 }}>{fmtBalanceCents(r.running_balance_cents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: "#111827" }}>
                <td style={{ ...td, fontWeight: 700, color: C.textSub }} colSpan={3}>TOTAL ({rows.length})</td>
                <td style={{ ...tdNum, fontWeight: 700 }}>{fmtCents(totals.debit)}</td>
                <td style={{ ...tdNum, fontWeight: 700 }}>{fmtCents(totals.credit)}</td>
                <td style={{ ...tdNum, fontWeight: 700, color: netCents !== 0 ? C.text : C.textMuted }}>{fmtBalanceCents(netCents)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  );
}
