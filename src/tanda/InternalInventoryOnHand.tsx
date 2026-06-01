// src/tanda/InternalInventoryOnHand.tsx
//
// Tangerine P15 — Inventory On-Hand by Brand Pool read-only report panel.
//
// Reads /api/internal/inventory-on-hand which aggregates inventory_layers
// (remaining_qty > 0) via v_inventory_on_hand_by_partition, grouped by
// entity / partition / item. NULL partition_id rows appear as "(unpartitioned)".
//
// Filters: brand (dropdown via /api/internal/brands), partition (derived from
// loaded rows), free-text search on SKU / description.
// Export: xlsx via <ExportButton>.

import { useEffect, useState, useMemo } from "react";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";

// ── types ────────────────────────────────────────────────────────────────────

type OnHandRow = {
  entity_id: string;
  partition_id: string | null;
  partition_code: string;
  partition_name: string;
  brand_id: string | null;
  brand_code: string | null;
  brand_name: string | null;
  item_id: string;
  sku_code: string | null;
  description: string | null;
  on_hand_qty: number | string;
  on_hand_value_cents: number | string;
};

type Brand = {
  id: string;
  code: string;
  name: string;
  is_default: boolean;
  sort_order: number;
};

// ── palette (mirrors other Internal* panels) ─────────────────────────────────

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
  groupHeaderBg: "#162033",
};

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: `1px solid ${C.primary}`,
  padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600,
};
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13,
  colorScheme: "dark",
};
const selectStyle: React.CSSProperties = { ...inputStyle, minWidth: 160 };
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

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtQty(v: number | string | null | undefined): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function fmtCents(v: number | string | null | undefined): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || n === 0) return "$0.00";
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.trunc(abs / 100);
  const frac = abs - whole * 100;
  return `${neg ? "-" : ""}$${whole.toLocaleString()}.${String(Math.round(frac)).padStart(2, "0")}`;
}

// ── component ────────────────────────────────────────────────────────────────

export default function InternalInventoryOnHand() {
  const [rows, setRows]           = useState<OnHandRow[]>([]);
  const [brands, setBrands]       = useState<Brand[]>([]);
  const [loading, setLoading]     = useState(true);
  const [err, setErr]             = useState<string | null>(null);

  // filters
  const [brandId, setBrandId]         = useState<string>("");
  const [partitionId, setPartitionId] = useState<string>("");
  const [search, setSearch]           = useState<string>("");

  // Fetch brand list once on mount for the brand dropdown.
  useEffect(() => {
    fetch("/api/internal/brands")
      .then((r) => r.json())
      .then((d) => setBrands(d.brands || []))
      .catch(() => {/* non-fatal; brand filter just stays empty */});
  }, []);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (brandId)     params.set("brand_id",     brandId);
      if (partitionId) params.set("partition_id", partitionId);
      if (search.trim().length >= 2) params.set("q", search.trim());
      const r = await fetch(`/api/internal/inventory-on-hand?${params.toString()}`);
      if (!r.ok) {
        const detail = await r.json().catch(() => ({}));
        throw new Error((detail as { error?: string }).error || `HTTP ${r.status}`);
      }
      const data = await r.json() as { rows: OnHandRow[] };
      setRows(data.rows || []);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  // Reload when brand/partition filters change. Search is applied on the fly
  // client-side (no round-trip), but a manual Refresh sends ?q= to the API.
  useEffect(() => { void load(); }, [brandId, partitionId]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Client-side text filter (instant, no extra fetch).
  const displayRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        (r.sku_code || "").toLowerCase().includes(q) ||
        (r.description || "").toLowerCase().includes(q)
    );
  }, [rows, search]);

  // Partition options derived from loaded rows (no separate API needed).
  const partitionOptions = useMemo<Array<{ id: string | null; code: string; name: string }>>(() => {
    const seen = new Map<string, { id: string | null; code: string; name: string }>();
    for (const r of rows) {
      const key = r.partition_id ?? "__null__";
      if (!seen.has(key)) {
        seen.set(key, { id: r.partition_id, code: r.partition_code, name: r.partition_name });
      }
    }
    return Array.from(seen.values()).sort((a, b) => a.code.localeCompare(b.code));
  }, [rows]);

  // Totals for footer.
  const totalQty   = displayRows.reduce((s, r) => s + Number(r.on_hand_qty ?? 0), 0);
  const totalValue = displayRows.reduce((s, r) => s + Number(r.on_hand_value_cents ?? 0), 0);

  // Export columns.
  const exportColumns: ExportColumn<Record<string, unknown>>[] = [
    { key: "partition_code",       header: "Pool Code" },
    { key: "partition_name",       header: "Pool Name" },
    { key: "brand_code",           header: "Brand Code" },
    { key: "brand_name",           header: "Brand" },
    { key: "sku_code",             header: "SKU" },
    { key: "description",          header: "Description" },
    { key: "on_hand_qty",          header: "On-Hand Qty",   format: "number" },
    { key: "on_hand_value_cents",  header: "On-Hand Value", format: "currency_cents" },
  ];

  return (
    <div style={{ color: C.text }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>📦 On-Hand by Pool</h2>
        <div style={{ fontSize: 11, color: C.textMuted }}>
          {displayRows.length} item{displayRows.length === 1 ? "" : "s"}
        </div>
      </div>

      {/* Filter bar */}
      <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        {/* Brand filter */}
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
          Brand
          <select
            value={brandId}
            onChange={(e) => { setBrandId(e.target.value); setPartitionId(""); }}
            style={selectStyle}
          >
            <option value="">All brands</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>{b.code} — {b.name}</option>
            ))}
          </select>
        </label>

        {/* Partition filter (populated from loaded rows) */}
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
          Pool
          <select
            value={partitionId}
            onChange={(e) => setPartitionId(e.target.value)}
            style={selectStyle}
          >
            <option value="">All pools</option>
            {partitionOptions.map((p) => (
              <option key={p.id ?? "__null__"} value={p.id ?? ""}>
                {p.code}{p.name !== p.code ? ` — ${p.name}` : ""}
              </option>
            ))}
          </select>
        </label>

        {/* Search */}
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
          Search (SKU / Description)
          <input
            type="search"
            placeholder="Filter rows…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ ...inputStyle, width: 220 }}
          />
        </label>

        <button onClick={() => void load()} style={{ ...btnPrimary, alignSelf: "flex-end" }} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>

        <div style={{ alignSelf: "flex-end" }}>
          <ExportButton
            rows={displayRows as unknown as Array<Record<string, unknown>>}
            filename="inventory-on-hand-by-pool"
            sheetName="On-Hand by Pool"
            columns={exportColumns}
          />
        </div>
      </div>

      {/* Error banner */}
      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          Error: {err}
        </div>
      )}

      {/* Table */}
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, maxHeight: "calc(100vh - 300px)", overflowY: "auto" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : displayRows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
            No on-hand inventory found for the selected filters.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Pool</th>
                <th style={th}>Brand</th>
                <th style={th}>SKU</th>
                <th style={th}>Description</th>
                <th style={{ ...th, textAlign: "right" }}>On-Hand Qty</th>
                <th style={{ ...th, textAlign: "right" }}>On-Hand Value</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((r, i) => (
                <tr
                  key={`${r.partition_id ?? "null"}-${r.item_id}-${i}`}
                  style={{ background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.02)" }}
                >
                  <td style={{ ...td, color: C.textSub }}>
                    <div style={{ fontWeight: 600, fontSize: 12 }}>{r.partition_code}</div>
                    {r.partition_name !== r.partition_code && (
                      <div style={{ fontSize: 11, color: C.textMuted }}>{r.partition_name}</div>
                    )}
                  </td>
                  <td style={{ ...td, color: C.textSub }}>
                    {r.brand_code ? (
                      <>
                        <span style={{ fontWeight: 600 }}>{r.brand_code}</span>
                        {r.brand_name && r.brand_name !== r.brand_code && (
                          <span style={{ color: C.textMuted, fontSize: 11 }}> — {r.brand_name}</span>
                        )}
                      </>
                    ) : (
                      <span style={{ color: C.textMuted }}>—</span>
                    )}
                  </td>
                  <td style={{ ...td, fontFamily: "monospace", fontSize: 12 }}>{r.sku_code || "—"}</td>
                  <td style={td}>{r.description || "—"}</td>
                  <td style={{ ...tdNum, color: Number(r.on_hand_qty) > 0 ? C.success : C.warn }}>
                    {fmtQty(r.on_hand_qty)}
                  </td>
                  <td style={tdNum}>{fmtCents(r.on_hand_value_cents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: "#111827" }}>
                <td colSpan={4} style={{ ...td, fontWeight: 700, color: C.text }}>
                  TOTAL ({displayRows.length} items)
                </td>
                <td style={{ ...tdNum, fontWeight: 700, color: C.success }}>{fmtQty(totalQty)}</td>
                <td style={{ ...tdNum, fontWeight: 700 }}>{fmtCents(totalValue)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  );
}
