// src/tanda/InternalAPAging.tsx
//
// Tangerine P7-7 — AP Aging admin panel (Reports menu group).
// Reads /api/internal/ap-aging. Mirrors InternalARAging structure: as-of date
// picker, vendor filter, color-coded buckets (current/1-30/31-60/61-90/91+).

import { useEffect, useState } from "react";
import ExportButton from "./exports/ExportButton";
import { useTablePrefs, TablePrefsButton, type ColumnDef } from "./components/TablePrefs";

const TABLE_KEY = "tanda.ap_aging";
const ALL_COLUMNS: ColumnDef[] = [
  { key: "vendor",   label: "Vendor" },
  { key: "current",  label: "Current" },
  { key: "b1_30",    label: "1-30" },
  { key: "b31_60",   label: "31-60" },
  { key: "b61_90",   label: "61-90" },
  { key: "b91_plus", label: "91+" },
  { key: "total",    label: "Total Open" },
];

type AgingRow = {
  entity_id?: string;
  vendor_id: string;
  vendor_name?: string | null;
  vendor_code?: string | null;
  // "current" (view mode) returns flat buckets one-row-per-bucket; "as_of"
  // (RPC mode) returns pivoted one-row-per-vendor. Carry both shapes.
  age_bucket?: string;
  outstanding_cents?: number | string;
  current_cents?: number | string;
  bucket_1_30_cents?: number | string;
  bucket_31_60_cents?: number | string;
  bucket_61_90_cents?: number | string;
  bucket_91_plus_cents?: number | string;
  total_outstanding_cents?: number | string;
  invoice_count?: number | string;
};

type PivotRow = {
  vendor_id: string;
  vendor_name: string | null;
  vendor_code: string | null;
  current: number;
  b1_30: number;
  b31_60: number;
  b61_90: number;
  b91_plus: number;
  total: number;
};

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6",
};

const BUCKET_COLOR = {
  current:  C.textSub,
  b1_30:    "#FACC15",
  b31_60:   "#FB923C",
  b61_90:   "#F87171",
  b91_plus: "#DC2626",
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

// View-mode rows arrive one per (vendor, bucket). Pivot them to one row per
// vendor so the UI matches the AR Aging layout.
function pivotViewRows(rows: AgingRow[]): PivotRow[] {
  const map = new Map<string, PivotRow>();
  for (const r of rows) {
    const id = r.vendor_id;
    if (!map.has(id)) {
      map.set(id, {
        vendor_id: id,
        vendor_name: r.vendor_name ?? null,
        vendor_code: r.vendor_code ?? null,
        current: 0, b1_30: 0, b31_60: 0, b61_90: 0, b91_plus: 0, total: 0,
      });
    }
    const acc = map.get(id)!;
    const out = Number(r.outstanding_cents || 0);
    acc.total += out;
    switch (r.age_bucket) {
      case "current": acc.current += out; break;
      case "1-30":    acc.b1_30 += out;   break;
      case "31-60":   acc.b31_60 += out;  break;
      case "61-90":   acc.b61_90 += out;  break;
      case "91+":     acc.b91_plus += out; break;
      default: break;
    }
  }
  return Array.from(map.values());
}

// RPC-mode rows are already pivoted — just rename to the local shape.
function rpcRowsToPivot(rows: AgingRow[]): PivotRow[] {
  return rows.map((r) => ({
    vendor_id: r.vendor_id,
    vendor_name: r.vendor_name ?? null,
    vendor_code: r.vendor_code ?? null,
    current:  Number(r.current_cents || 0),
    b1_30:    Number(r.bucket_1_30_cents || 0),
    b31_60:   Number(r.bucket_31_60_cents || 0),
    b61_90:   Number(r.bucket_61_90_cents || 0),
    b91_plus: Number(r.bucket_91_plus_cents || 0),
    total:    Number(r.total_outstanding_cents || 0),
  }));
}

export default function InternalAPAging() {
  const [pivot, setPivot] = useState<PivotRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [asOf, setAsOf] = useState<string>(todayISO());
  const [vendorFilter, setVendorFilter] = useState<string>("");
  const [mode, setMode] = useState<string>("current");
  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(TABLE_KEY, ALL_COLUMNS);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (asOf && asOf !== todayISO()) params.set("as_of", asOf);
      const r = await fetch(`/api/internal/ap-aging?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const data = await r.json();
      setMode(data.mode || "current");
      const rows = (data.rows || []) as AgingRow[];
      setPivot(data.mode === "as_of" ? rpcRowsToPivot(rows) : pivotViewRows(rows));
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const filtered = vendorFilter.trim()
    ? pivot.filter((r) =>
        (r.vendor_name || "").toLowerCase().includes(vendorFilter.trim().toLowerCase()) ||
        (r.vendor_code || "").toLowerCase().includes(vendorFilter.trim().toLowerCase()),
      )
    : pivot;

  const totals = filtered.reduce(
    (acc, r) => {
      acc.current += r.current;
      acc.b1_30 += r.b1_30;
      acc.b31_60 += r.b31_60;
      acc.b61_90 += r.b61_90;
      acc.b91_plus += r.b91_plus;
      acc.total += r.total;
      return acc;
    },
    { current: 0, b1_30: 0, b31_60: 0, b61_90: 0, b91_plus: 0, total: 0 },
  );

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>AP Aging</h2>
        <div style={{ fontSize: 11, color: C.textMuted }}>mode: <strong>{mode}</strong></div>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
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
          placeholder="Filter vendor name or code…"
          value={vendorFilter}
          onChange={(e) => setVendorFilter(e.target.value)}
          style={{ ...inputStyle, maxWidth: 320 }}
        />
        <button onClick={() => void load()} style={btnSecondary}>Refresh</button>
        <ExportButton
          rows={filtered as unknown as Array<Record<string, unknown>>}
          filename="ap-aging"
          sheetName="AP Aging"
          columns={[
            { key: "vendor_name", header: "Vendor" },
            { key: "vendor_code", header: "Code" },
            { key: "current",     header: "Current",    format: "currency_cents" },
            { key: "b1_30",       header: "1-30",       format: "currency_cents" },
            { key: "b31_60",      header: "31-60",      format: "currency_cents" },
            { key: "b61_90",      header: "61-90",      format: "currency_cents" },
            { key: "b91_plus",    header: "91+",        format: "currency_cents" },
            { key: "total",       header: "Total Open", format: "currency_cents" },
          ]}
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
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No vendors with open AP.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th} hidden={!visibleColumns.has("vendor")}>Vendor</th>
                <th style={{ ...th, textAlign: "right" }} hidden={!visibleColumns.has("current")}>Current</th>
                <th style={{ ...th, textAlign: "right", color: BUCKET_COLOR.b1_30 }} hidden={!visibleColumns.has("b1_30")}>1-30</th>
                <th style={{ ...th, textAlign: "right", color: BUCKET_COLOR.b31_60 }} hidden={!visibleColumns.has("b31_60")}>31-60</th>
                <th style={{ ...th, textAlign: "right", color: BUCKET_COLOR.b61_90 }} hidden={!visibleColumns.has("b61_90")}>61-90</th>
                <th style={{ ...th, textAlign: "right", color: BUCKET_COLOR.b91_plus }} hidden={!visibleColumns.has("b91_plus")}>91+</th>
                <th style={{ ...th, textAlign: "right" }} hidden={!visibleColumns.has("total")}>Total Open</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.vendor_id}>
                  <td style={td} hidden={!visibleColumns.has("vendor")}>
                    <strong>{r.vendor_name || r.vendor_code || r.vendor_id}</strong>
                    {r.vendor_code && r.vendor_name && (
                      <span style={{ color: C.textMuted, marginLeft: 6, fontSize: 11 }}>({r.vendor_code})</span>
                    )}
                  </td>
                  <td style={tdNum} hidden={!visibleColumns.has("current")}>{fmtCents(r.current)}</td>
                  <td style={{ ...tdNum, color: r.b1_30    > 0 ? BUCKET_COLOR.b1_30    : C.textMuted }} hidden={!visibleColumns.has("b1_30")}>{fmtCents(r.b1_30)}</td>
                  <td style={{ ...tdNum, color: r.b31_60   > 0 ? BUCKET_COLOR.b31_60   : C.textMuted }} hidden={!visibleColumns.has("b31_60")}>{fmtCents(r.b31_60)}</td>
                  <td style={{ ...tdNum, color: r.b61_90   > 0 ? BUCKET_COLOR.b61_90   : C.textMuted }} hidden={!visibleColumns.has("b61_90")}>{fmtCents(r.b61_90)}</td>
                  <td style={{ ...tdNum, color: r.b91_plus > 0 ? BUCKET_COLOR.b91_plus : C.textMuted, fontWeight: r.b91_plus > 0 ? 700 : 400 }} hidden={!visibleColumns.has("b91_plus")}>{fmtCents(r.b91_plus)}</td>
                  <td style={{ ...tdNum, fontWeight: 700 }} hidden={!visibleColumns.has("total")}>{fmtCents(r.total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: "#111827" }}>
                <td style={{ ...td, fontWeight: 700, color: C.textSub }} hidden={!visibleColumns.has("vendor")}>TOTAL ({filtered.length})</td>
                <td style={{ ...tdNum, fontWeight: 700 }} hidden={!visibleColumns.has("current")}>{fmtCents(totals.current)}</td>
                <td style={{ ...tdNum, fontWeight: 700, color: BUCKET_COLOR.b1_30 }} hidden={!visibleColumns.has("b1_30")}>{fmtCents(totals.b1_30)}</td>
                <td style={{ ...tdNum, fontWeight: 700, color: BUCKET_COLOR.b31_60 }} hidden={!visibleColumns.has("b31_60")}>{fmtCents(totals.b31_60)}</td>
                <td style={{ ...tdNum, fontWeight: 700, color: BUCKET_COLOR.b61_90 }} hidden={!visibleColumns.has("b61_90")}>{fmtCents(totals.b61_90)}</td>
                <td style={{ ...tdNum, fontWeight: 700, color: BUCKET_COLOR.b91_plus }} hidden={!visibleColumns.has("b91_plus")}>{fmtCents(totals.b91_plus)}</td>
                <td style={{ ...tdNum, fontWeight: 700 }} hidden={!visibleColumns.has("total")}>{fmtCents(totals.total)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  );
}
