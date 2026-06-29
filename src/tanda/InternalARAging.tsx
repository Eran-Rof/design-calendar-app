// src/tanda/InternalARAging.tsx
//
// Tangerine P4-6 — AR Aging admin panel.
// Reads /api/internal/ar-aging (default mode = v_ar_aging using CURRENT_DATE;
// pass ?as_of=YYYY-MM-DD to use the parameterized RPC).
//
// Rows show per-customer open balance + 5 bucket columns. Color-coded for
// quick scan: current (neutral), 1-30 (yellow), 31-60 (orange), 61-90 (red),
// 91-120+ (deeper red).

import { useEffect, useState } from "react";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { useTablePrefs, TablePrefsButton, type ColumnDef } from "./components/TablePrefs";

const TABLE_KEY = "tanda.ar_aging";
const ALL_COLUMNS: ColumnDef[] = [
  { key: "customer", label: "Customer" },
  { key: "current",  label: "Current" },
  { key: "b30",      label: "1-30" },
  { key: "b60",      label: "31-60" },
  { key: "b90",      label: "61-90" },
  { key: "b120plus", label: "91-120+" },
  { key: "total",    label: "Total Open" },
];

type AgingRow = {
  entity_id: string;
  customer_id: string;
  customer_name: string | null;
  customer_code: string | null;
  bucket_current_cents: number | string;
  bucket_30_cents: number | string;
  bucket_60_cents: number | string;
  bucket_90_cents: number | string;
  bucket_120plus_cents: number | string;
  total_open_cents: number | string;
};

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

const BUCKET_COLOR: Record<string, string> = {
  current:    C.textSub,
  b30:        "#FACC15", // yellow
  b60:        "#FB923C", // orange
  b90:        "#F87171", // red
  b120plus:   "#DC2626", // deep red
};

const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
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

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function InternalARAging() {
  const [rows, setRows] = useState<AgingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [asOf, setAsOf] = useState<string>(todayISO());
  const [customerFilter, setCustomerFilter] = useState<string>("");
  const [mode, setMode] = useState<string>("current");
  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(TABLE_KEY, ALL_COLUMNS);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      // Use as-of mode whenever the user has changed the date away from today.
      // Default-today still uses the cheaper v_ar_aging view.
      if (asOf && asOf !== todayISO()) params.set("as_of", asOf);
      const r = await fetch(`/api/internal/ar-aging?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const data = await r.json();
      setMode(data.mode || "current");
      setRows((data.rows || []) as AgingRow[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const filtered = customerFilter.trim()
    ? rows.filter((r) =>
        (r.customer_name || "").toLowerCase().includes(customerFilter.trim().toLowerCase()) ||
        (r.customer_code || "").toLowerCase().includes(customerFilter.trim().toLowerCase()),
      )
    : rows;

  // Totals row.
  const totals = filtered.reduce(
    (acc, r) => {
      acc.current += Number(r.bucket_current_cents || 0);
      acc.b30 += Number(r.bucket_30_cents || 0);
      acc.b60 += Number(r.bucket_60_cents || 0);
      acc.b90 += Number(r.bucket_90_cents || 0);
      acc.b120plus += Number(r.bucket_120plus_cents || 0);
      acc.total += Number(r.total_open_cents || 0);
      return acc;
    },
    { current: 0, b30: 0, b60: 0, b90: 0, b120plus: 0, total: 0 },
  );

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>AR Aging</h2>
        <div style={{ fontSize: 11, color: C.textMuted }}>
          mode: <strong>{mode}</strong>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          As of:
          <input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            style={{ ...inputStyle, width: 160 }}
          />
        </label>
        <input
          type="text"
          placeholder="Filter customer name or code…"
          value={customerFilter}
          onChange={(e) => setCustomerFilter(e.target.value)}
          style={{ ...inputStyle, maxWidth: 320 }}
        />
        <button onClick={() => void load()} style={btnSecondary}>Refresh</button>
        <ExportButton
          rows={(() => {
            const out: Array<Record<string, unknown>> = filtered.map((r) => ({
              kind: "row",
              customer_code: r.customer_code,
              customer_name: r.customer_name,
              bucket_current_cents: r.bucket_current_cents,
              bucket_30_cents: r.bucket_30_cents,
              bucket_60_cents: r.bucket_60_cents,
              bucket_90_cents: r.bucket_90_cents,
              bucket_120plus_cents: r.bucket_120plus_cents,
              total_open_cents: r.total_open_cents,
            }));
            out.push({
              kind: "total",
              customer_code: "",
              customer_name: `TOTAL (${filtered.length})`,
              bucket_current_cents: totals.current,
              bucket_30_cents: totals.b30,
              bucket_60_cents: totals.b60,
              bucket_90_cents: totals.b90,
              bucket_120plus_cents: totals.b120plus,
              total_open_cents: totals.total,
            });
            return out;
          })()}
          filename={`ar-aging-${asOf}`}
          sheetName="AR Aging"
          columns={[
            { key: "kind",                 header: "Kind" },
            { key: "customer_code",        header: "Code" },
            { key: "customer_name",        header: "Customer" },
            { key: "bucket_current_cents", header: "Current", format: "currency_cents" },
            { key: "bucket_30_cents",      header: "1-30",    format: "currency_cents" },
            { key: "bucket_60_cents",      header: "31-60",   format: "currency_cents" },
            { key: "bucket_90_cents",      header: "61-90",   format: "currency_cents" },
            { key: "bucket_120plus_cents", header: "91-120+", format: "currency_cents" },
            { key: "total_open_cents",     header: "Total Open", format: "currency_cents" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
        <TablePrefsButton
          tableKey={TABLE_KEY}
          columns={ALL_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
          onSetAll={setAllVisible}
        />
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          Error: {err}
        </div>
      )}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, maxHeight: "calc(100vh - 240px)", overflowY: "auto" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No customers with open AR.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th} hidden={!visibleColumns.has("customer")}>Customer</th>
                <th style={{ ...th, textAlign: "right" }} hidden={!visibleColumns.has("current")}>Current</th>
                <th style={{ ...th, textAlign: "right", color: BUCKET_COLOR.b30 }} hidden={!visibleColumns.has("b30")}>1-30</th>
                <th style={{ ...th, textAlign: "right", color: BUCKET_COLOR.b60 }} hidden={!visibleColumns.has("b60")}>31-60</th>
                <th style={{ ...th, textAlign: "right", color: BUCKET_COLOR.b90 }} hidden={!visibleColumns.has("b90")}>61-90</th>
                <th style={{ ...th, textAlign: "right", color: BUCKET_COLOR.b120plus }} hidden={!visibleColumns.has("b120plus")}>91-120+</th>
                <th style={{ ...th, textAlign: "right" }} hidden={!visibleColumns.has("total")}>Total Open</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.customer_id}>
                  <td style={td} hidden={!visibleColumns.has("customer")}>
                    <strong>{r.customer_name || r.customer_code || "—"}</strong>
                    {r.customer_code && r.customer_name && (
                      <span style={{ color: C.textMuted, marginLeft: 6, fontSize: 11 }}>
                        ({r.customer_code})
                      </span>
                    )}
                  </td>
                  <td style={tdNum} hidden={!visibleColumns.has("current")}>{fmtCents(r.bucket_current_cents)}</td>
                  <td style={{ ...tdNum, color: Number(r.bucket_30_cents) > 0 ? BUCKET_COLOR.b30 : C.textMuted }} hidden={!visibleColumns.has("b30")}>{fmtCents(r.bucket_30_cents)}</td>
                  <td style={{ ...tdNum, color: Number(r.bucket_60_cents) > 0 ? BUCKET_COLOR.b60 : C.textMuted }} hidden={!visibleColumns.has("b60")}>{fmtCents(r.bucket_60_cents)}</td>
                  <td style={{ ...tdNum, color: Number(r.bucket_90_cents) > 0 ? BUCKET_COLOR.b90 : C.textMuted }} hidden={!visibleColumns.has("b90")}>{fmtCents(r.bucket_90_cents)}</td>
                  <td style={{ ...tdNum, color: Number(r.bucket_120plus_cents) > 0 ? BUCKET_COLOR.b120plus : C.textMuted, fontWeight: Number(r.bucket_120plus_cents) > 0 ? 700 : 400 }} hidden={!visibleColumns.has("b120plus")}>{fmtCents(r.bucket_120plus_cents)}</td>
                  <td style={{ ...tdNum, fontWeight: 700 }} hidden={!visibleColumns.has("total")}>{fmtCents(r.total_open_cents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: "#111827" }}>
                <td style={{ ...td, fontWeight: 700, color: C.textSub }} hidden={!visibleColumns.has("customer")}>TOTAL ({filtered.length})</td>
                <td style={{ ...tdNum, fontWeight: 700 }} hidden={!visibleColumns.has("current")}>{fmtCents(totals.current)}</td>
                <td style={{ ...tdNum, fontWeight: 700, color: BUCKET_COLOR.b30 }} hidden={!visibleColumns.has("b30")}>{fmtCents(totals.b30)}</td>
                <td style={{ ...tdNum, fontWeight: 700, color: BUCKET_COLOR.b60 }} hidden={!visibleColumns.has("b60")}>{fmtCents(totals.b60)}</td>
                <td style={{ ...tdNum, fontWeight: 700, color: BUCKET_COLOR.b90 }} hidden={!visibleColumns.has("b90")}>{fmtCents(totals.b90)}</td>
                <td style={{ ...tdNum, fontWeight: 700, color: BUCKET_COLOR.b120plus }} hidden={!visibleColumns.has("b120plus")}>{fmtCents(totals.b120plus)}</td>
                <td style={{ ...tdNum, fontWeight: 700 }} hidden={!visibleColumns.has("total")}>{fmtCents(totals.total)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  );
}
