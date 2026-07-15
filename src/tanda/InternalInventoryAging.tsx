// src/tanda/InternalInventoryAging.tsx
//
// Inventory Aging — best-in-class aged-inventory report. READ-ONLY.
// Ages TRUE FIFO layers (inventory_layers.received_at) as of ANY chosen "aged
// date", splits on-hand across configurable age buckets, and surfaces carrying
// cost (interest + storage, ATS constants) and velocity (last-sold, days-since-
// sale, units-90, weeks-of-supply) per grain. Richer than the ATS aged-inventory
// report: true per-layer ages, an as-of date, configurable grain + buckets, a
// full filter set, and a per-grain FIFO-layer drill.
//
// Backed by inventory_aging_report() + inventory_aging_kpis() (migration
// 20261090000000) via /api/internal/inventory-aging/*.
//
// House UI rules: full-row click, no ↗ glyphs, blue identifiers, dark palette,
// dark selects, no decorative emoji, responsive modal min(cap,95vw)/90vh with a
// frozen footer, MM/DD/YYYY dates, no visible UUIDs, universal ExportButton.

import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtDateDisplay } from "../utils/tandaTypes";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";
import { useSeqGuard } from "./hooks/useSeqGuard";
import { bucketLabels, DEFAULT_BUCKET_DAYS } from "../lib/inventoryAging";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444", purple: "#A78BFA",
};
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2, whiteSpace: "nowrap" };
const thR: React.CSSProperties = { ...th, textAlign: "right" };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13, whiteSpace: "nowrap" };
const tdR: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };
const selectStyle: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, colorScheme: "dark" };
const inputStyle: React.CSSProperties = { ...selectStyle };
const btnSecondary: React.CSSProperties = { background: C.card, color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 14px", borderRadius: 6, fontSize: 13, cursor: "pointer" };
const btnGhost: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "4px 8px", borderRadius: 4, fontSize: 11, cursor: "pointer" };

type Opt = { id: string; name: string };
type Row = {
  grain_key: string; grain_label: string;
  style_code: string | null; color: string | null; size: string | null; gender: string | null;
  category_name: string | null; brand_name: string | null; vendor_name: string | null; location_name: string | null;
  on_hand_qty: number; cost_value_cents: number; avg_unit_cost_cents: number;
  wavg_age_days: number; oldest_age_days: number; last_received: string | null;
  b1_qty: number; b1_value_cents: number; b2_qty: number; b2_value_cents: number;
  b3_qty: number; b3_value_cents: number; b4_qty: number; b4_value_cents: number;
  b5_qty: number; b5_value_cents: number; b6_qty: number; b6_value_cents: number;
  int_annual_cents: number; sto_annual_cents: number;
  carry_pct: number; carry_per_unit_cents: number;
  last_sold: string | null; days_since_last_sale: number | null;
  units_sold_90: number | null; weeks_of_supply: number | null;
  uncosted_qty: number;
};
type Kpis = {
  total_qty: number; total_value_cents: number; wavg_age_days: number; oldest_age_days: number;
  distinct_skus: number; distinct_styles: number;
  b1_qty: number; b1_value_cents: number; b2_qty: number; b2_value_cents: number;
  b3_qty: number; b3_value_cents: number; b4_qty: number; b4_value_cents: number;
  b5_qty: number; b5_value_cents: number; b6_qty: number; b6_value_cents: number;
  dead_qty: number; dead_value_cents: number; carry_annual_cents: number; uncosted_qty: number;
};
type Layer = {
  id: string; sku_code: string | null; style_code: string | null; color: string | null; size: string | null;
  description: string | null; source_kind: string | null; lot_number: string | null; location_name: string | null;
  received_at: string | null; eff_received: string | null; age_days: number; remaining_qty: number; original_qty: number;
  unit_cost_cents: number; eff_unit_cost_cents: number; is_uncosted: boolean; value_cents: number;
};

const GROUPS: { key: string; label: string }[] = [
  { key: "style", label: "Style" },
  { key: "style_color", label: "Style + Color" },
  { key: "sku", label: "SKU (size)" },
  { key: "category", label: "Category" },
  { key: "warehouse", label: "Warehouse" },
  { key: "vendor", label: "Vendor" },
];

const n = (v: number | string | null | undefined) => {
  const x = typeof v === "string" ? Number(v) : v ?? 0;
  return Number.isFinite(x as number) ? (x as number) : 0;
};
const fmtInt = (v: number | string | null | undefined) => Math.round(n(v)).toLocaleString();
const fmtUsd = (cents: number | string | null | undefined) =>
  `$${(n(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtUsd0 = (cents: number | string | null | undefined) =>
  `$${Math.round(n(cents) / 100).toLocaleString("en-US")}`;
const fmtPct = (v: number | string | null | undefined) => `${(n(v) * 100).toFixed(1)}%`;
const fmtDays = (v: number | string | null | undefined) => `${Math.round(n(v)).toLocaleString()}d`;
const fmtWos = (v: number | null) => (v == null ? "—" : v > 520 ? "10y+" : `${v.toFixed(1)}w`);
const todayISO = () => new Date(Date.now()).toISOString().slice(0, 10);

function Tile({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: "12px 16px", minWidth: 140, flex: "1 1 140px" }}>
      <div style={{ color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ color: color || C.text, fontSize: 22, fontWeight: 700, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {sub ? <div style={{ color: C.textSub, fontSize: 12, marginTop: 2 }}>{sub}</div> : null}
    </div>
  );
}

// Aged-date presets — month/quarter/year-end + rolling look-backs, per the
// house "date pickers get presets" rule; the aged date is this report's spine.
function agedDatePresets(): { label: string; iso: string; title: string }[] {
  const t = new Date(todayISO() + "T00:00:00Z");
  const y = t.getUTCFullYear(), m = t.getUTCMonth();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const back = (days: number) => { const d = new Date(t); d.setUTCDate(d.getUTCDate() - days); return iso(d); };
  const monthEnd = iso(new Date(Date.UTC(y, m + 1, 0)));
  const qEnd = iso(new Date(Date.UTC(y, Math.floor(m / 3) * 3 + 3, 0)));
  const yEnd = iso(new Date(Date.UTC(y, 11, 31)));
  return [
    { label: "Today", iso: todayISO(), title: "Age everything to today" },
    { label: "Month-end", iso: monthEnd, title: "Age to this month's end" },
    { label: "Quarter-end", iso: qEnd, title: "Age to this quarter's end" },
    { label: "Year-end", iso: yEnd, title: "Age to this calendar year-end" },
    { label: "−30d", iso: back(30), title: "Age as of 30 days ago" },
    { label: "−90d", iso: back(90), title: "Age as of 90 days ago" },
    { label: "−180d", iso: back(180), title: "Age as of 180 days ago" },
  ];
}

export default function InternalInventoryAging() {
  const seqGuard = useSeqGuard();

  // ── filter state ──────────────────────────────────────────────────────────
  const [asOf, setAsOf] = useState<string>(todayISO());
  const [groupBy, setGroupBy] = useState<string>("style");
  const [bucketsRaw, setBucketsRaw] = useState<string>(DEFAULT_BUCKET_DAYS.join(","));
  const [categoryId, setCategoryId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [gender, setGender] = useState("");
  const [styleCode, setStyleCode] = useState("");
  const [color, setColor] = useState("");
  const [size, setSize] = useState("");
  const [minAge, setMinAge] = useState("");
  const [bucket, setBucket] = useState("");        // "" | 1..6
  const [slowDays, setSlowDays] = useState("");
  const [minValue, setMinValue] = useState("");    // dollars in UI → cents to API
  const [minQty, setMinQty] = useState("");
  const [includeZero, setIncludeZero] = useState(false);
  const [search, setSearch] = useState("");

  // ── data ──────────────────────────────────────────────────────────────────
  const [rows, setRows] = useState<Row[]>([]);
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [bucketDays, setBucketDays] = useState<number[]>([...DEFAULT_BUCKET_DAYS]);
  const [opts, setOpts] = useState<{ categories: Opt[]; brands: Opt[]; vendors: Opt[]; locations: Opt[]; genders: string[] }>(
    { categories: [], brands: [], vendors: [], locations: [], genders: [] });
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // ── drill ─────────────────────────────────────────────────────────────────
  const [drill, setDrill] = useState<Row | null>(null);
  const [layers, setLayers] = useState<Layer[] | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);

  // load filter option lists once
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/internal/inventory-aging/filters");
        if (!r.ok) return;
        const d = await r.json();
        setOpts({
          categories: d.categories || [], brands: d.brands || [], vendors: d.vendors || [],
          locations: d.locations || [], genders: d.genders || [],
        });
      } catch { /* non-fatal */ }
    })();
  }, []);

  const load = useCallback(async () => {
    const seq = seqGuard.begin();
    setLoading(true); setErr(null);
    try {
      const p = new URLSearchParams();
      if (asOf && asOf !== todayISO()) p.set("as_of", asOf);
      p.set("group_by", groupBy);
      if (bucketsRaw.trim() && bucketsRaw.trim() !== DEFAULT_BUCKET_DAYS.join(",")) p.set("buckets", bucketsRaw.trim());
      if (categoryId) p.set("category_id", categoryId);
      if (brandId) p.set("brand_id", brandId);
      if (vendorId) p.set("vendor_id", vendorId);
      if (locationId) p.set("location_id", locationId);
      if (gender) p.set("gender", gender);
      if (styleCode.trim()) p.set("style_code", styleCode.trim());
      if (color.trim()) p.set("color", color.trim());
      if (size.trim()) p.set("size", size.trim());
      if (minAge.trim()) p.set("min_age_days", String(parseInt(minAge, 10) || 0));
      if (bucket) p.set("bucket", bucket);
      if (slowDays.trim()) p.set("slow_days", String(parseInt(slowDays, 10) || 0));
      if (minValue.trim()) p.set("min_value_cents", String(Math.round((parseFloat(minValue) || 0) * 100)));
      if (minQty.trim()) p.set("min_qty", String(parseFloat(minQty) || 0));
      if (includeZero) p.set("include_zero", "1");

      const r = await fetch(`/api/internal/inventory-aging/report?${p.toString()}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      if (!seqGuard.isCurrent(seq)) return;
      setRows(Array.isArray(d.rows) ? d.rows : []);
      setKpis(d.kpis || null);
      setBucketDays(Array.isArray(d.bucket_days) && d.bucket_days.length === 5 ? d.bucket_days : [...DEFAULT_BUCKET_DAYS]);
    } catch (e) {
      if (!seqGuard.isCurrent(seq)) return;
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (seqGuard.isCurrent(seq)) setLoading(false);
    }
  }, [asOf, groupBy, bucketsRaw, categoryId, brandId, vendorId, locationId, gender, styleCode, color, size, minAge, bucket, slowDays, minValue, minQty, includeZero, seqGuard]);

  useEffect(() => { void load(); }, [load]);

  const openDrill = useCallback(async (row: Row) => {
    setDrill(row); setLayers(null); setDrillLoading(true);
    try {
      const p = new URLSearchParams();
      p.set("group_by", groupBy);
      p.set("grain_key", row.grain_key);
      if (asOf) p.set("as_of", asOf);
      if (includeZero) p.set("include_zero", "1");
      const r = await fetch(`/api/internal/inventory-aging/layers?${p.toString()}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setLayers(Array.isArray(d.layers) ? d.layers : []);
    } catch {
      setLayers([]);
    } finally {
      setDrillLoading(false);
    }
  }, [groupBy, asOf, includeZero]);

  const labels = useMemo(() => bucketLabels(bucketDays), [bucketDays]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.grain_label, r.style_code, r.color, r.size, r.vendor_name, r.category_name, r.brand_name, r.location_name]
        .some((v) => (v || "").toLowerCase().includes(q)));
  }, [rows, search]);

  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(filtered, {
    persistKey: "tangerine:inv-aging:sort",
    accessors: {
      on_hand_qty: (r) => n(r.on_hand_qty), cost_value_cents: (r) => n(r.cost_value_cents),
      wavg_age_days: (r) => n(r.wavg_age_days), oldest_age_days: (r) => n(r.oldest_age_days),
      carry_pct: (r) => n(r.carry_pct), carry_annual: (r) => n(r.int_annual_cents) + n(r.sto_annual_cents),
      days_since_last_sale: (r) => (r.days_since_last_sale == null ? -1 : n(r.days_since_last_sale)),
      weeks_of_supply: (r) => (r.weeks_of_supply == null ? Number.MAX_SAFE_INTEGER : n(r.weeks_of_supply)),
      b6_value_cents: (r) => n(r.b6_value_cents),
    },
  });

  const bucketCell = (r: Row, i: number) => {
    const qty = n([r.b1_qty, r.b2_qty, r.b3_qty, r.b4_qty, r.b5_qty, r.b6_qty][i]);
    const val = n([r.b1_value_cents, r.b2_value_cents, r.b3_value_cents, r.b4_value_cents, r.b5_value_cents, r.b6_value_cents][i]);
    if (qty === 0 && val === 0) return <td key={i} style={{ ...tdR, color: C.textMuted }}>—</td>;
    const stale = i >= 4; // 181-365 & 365+
    return (
      <td key={i} style={{ ...tdR, color: stale && val > 0 ? C.warn : C.text }} title={`${fmtInt(qty)} units`}>
        {fmtUsd0(val)}
      </td>
    );
  };

  const exportRows = useMemo(() => sorted.map((r) => ({
    grain: r.grain_label, style: r.style_code, color: r.color, size: r.size,
    category: r.category_name, brand: r.brand_name, vendor: r.vendor_name, warehouse: r.location_name,
    on_hand_qty: n(r.on_hand_qty), cost_value_cents: n(r.cost_value_cents), avg_unit_cost_cents: n(r.avg_unit_cost_cents),
    wavg_age_days: Math.round(n(r.wavg_age_days)), oldest_age_days: n(r.oldest_age_days), last_received: r.last_received,
    b1_value_cents: n(r.b1_value_cents), b2_value_cents: n(r.b2_value_cents), b3_value_cents: n(r.b3_value_cents),
    b4_value_cents: n(r.b4_value_cents), b5_value_cents: n(r.b5_value_cents), b6_value_cents: n(r.b6_value_cents),
    carry_pct: n(r.carry_pct), carry_annual_cents: n(r.int_annual_cents) + n(r.sto_annual_cents),
    last_sold: r.last_sold, days_since_last_sale: r.days_since_last_sale, units_sold_90: r.units_sold_90,
    weeks_of_supply: r.weeks_of_supply, uncosted_qty: n(r.uncosted_qty),
  })), [sorted]);

  const exportColumns: ExportColumn<Record<string, unknown>>[] = useMemo(() => [
    { key: "grain", header: "Grain" },
    { key: "style", header: "Style" }, { key: "color", header: "Color" }, { key: "size", header: "Size" },
    { key: "category", header: "Category" }, { key: "vendor", header: "Vendor" }, { key: "warehouse", header: "Warehouse" },
    { key: "on_hand_qty", header: "On-hand" },
    { key: "cost_value_cents", header: "Value $", format: "currency_cents" },
    { key: "avg_unit_cost_cents", header: "Avg cost", format: "currency_cents" },
    { key: "wavg_age_days", header: "Wavg age (d)" }, { key: "oldest_age_days", header: "Oldest (d)" },
    { key: "last_received", header: "Last received" },
    { key: "b1_value_cents", header: `${labels[0]} $`, format: "currency_cents" },
    { key: "b2_value_cents", header: `${labels[1]} $`, format: "currency_cents" },
    { key: "b3_value_cents", header: `${labels[2]} $`, format: "currency_cents" },
    { key: "b4_value_cents", header: `${labels[3]} $`, format: "currency_cents" },
    { key: "b5_value_cents", header: `${labels[4]} $`, format: "currency_cents" },
    { key: "b6_value_cents", header: `${labels[5]} $`, format: "currency_cents" },
    { key: "carry_pct", header: "Carry %/yr" },
    { key: "carry_annual_cents", header: "Carry $/yr", format: "currency_cents" },
    { key: "last_sold", header: "Last sold" }, { key: "days_since_last_sale", header: "Days since sale" },
    { key: "units_sold_90", header: "Units sold 90d" }, { key: "weeks_of_supply", header: "Weeks of supply" },
    { key: "uncosted_qty", header: "Uncosted units" },
  ], [labels]);

  const grainLabel = GROUPS.find((g) => g.key === groupBy)?.label || "Style";

  return (
    <div style={{ padding: 20, color: C.text, background: C.bg, minHeight: "100%" }}>
      <div style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Inventory Aging</h2>
        <div style={{ color: C.textMuted, fontSize: 13, marginTop: 2 }}>
          FIFO-layer aged inventory as of a chosen date, with carrying cost and velocity. Read-only.
        </div>
        <div style={{ color: C.textSub, fontSize: 12, marginTop: 6, maxWidth: 900, lineHeight: 1.5 }}>
          Mirrored (Xoro-snapshot) stock ages off its <strong>last received date</strong> (ATS feed, then
          Tangerine receipt history) — the same basis ATS uses; Tangerine-received layers age off their true
          receipt date. Cost fills from the layer, then average cost, then item cost; units with no cost on
          file are counted as <strong>Uncosted</strong> and excluded from $ (quantities are always exact).
        </div>
      </div>

      {/* KPI header */}
      {kpis && (
        <>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", margin: "12px 0" }}>
            <Tile label="On-hand value" value={fmtUsd0(kpis.total_value_cents)} sub={`${fmtInt(kpis.total_qty)} units`} color={C.primary} />
            <Tile label="Wavg age" value={fmtDays(kpis.wavg_age_days)} sub={`oldest ${fmtDays(kpis.oldest_age_days)}`} />
            <Tile label="SKUs / styles" value={`${fmtInt(kpis.distinct_skus)} / ${fmtInt(kpis.distinct_styles)}`} />
            <Tile label={`Dead stock (>${bucketDays[4]}d)`} value={fmtUsd0(kpis.dead_value_cents)}
                  sub={`${fmtInt(kpis.dead_qty)} units`} color={n(kpis.dead_value_cents) > 0 ? C.warn : C.success} />
            <Tile label="Carrying cost / yr" value={fmtUsd0(kpis.carry_annual_cents)}
                  sub="interest + storage" color={C.purple} />
            {n(kpis.uncosted_qty) > 0 && (
              <Tile label="Uncosted units" value={fmtInt(kpis.uncosted_qty)}
                    sub="no cost on file — excluded from $" color={C.warn} />
            )}
          </div>
          {/* bucket distribution strip */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
            {labels.map((lab, i) => {
              const val = n([kpis.b1_value_cents, kpis.b2_value_cents, kpis.b3_value_cents, kpis.b4_value_cents, kpis.b5_value_cents, kpis.b6_value_cents][i]);
              const qty = n([kpis.b1_qty, kpis.b2_qty, kpis.b3_qty, kpis.b4_qty, kpis.b5_qty, kpis.b6_qty][i]);
              const pct = n(kpis.total_value_cents) > 0 ? (val / n(kpis.total_value_cents)) * 100 : 0;
              const stale = i >= 4;
              return (
                <div key={i} style={{ flex: "1 1 120px", minWidth: 110, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: "8px 10px" }}>
                  <div style={{ fontSize: 11, color: stale ? C.warn : C.textMuted, fontWeight: 600 }}>{lab} days</div>
                  <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>{fmtUsd0(val)}</div>
                  <div style={{ fontSize: 11, color: C.textSub }}>{fmtInt(qty)} u · {pct.toFixed(0)}%</div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Aged-date + presets */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          Aged date:
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} style={{ ...inputStyle, width: 160 }} />
        </label>
        {agedDatePresets().map((p) => (
          <button key={p.label} onClick={() => setAsOf(p.iso)} title={p.title}
                  style={{ ...btnGhost, ...(asOf === p.iso ? { borderColor: C.primary, color: C.primary } : {}) }}>
            {p.label}
          </button>
        ))}
      </div>

      {/* filter bar */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: C.textSub, display: "flex", alignItems: "center", gap: 6 }}>
          Group by:
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} style={{ ...selectStyle, width: 150 }}>
            {GROUPS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
          </select>
        </label>
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} style={{ ...selectStyle, width: 160 }} title="Category">
          <option value="">All categories</option>
          {opts.categories.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} style={{ ...selectStyle, width: 160 }} title="Vendor">
          <option value="">All vendors</option>
          {opts.vendors.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        <select value={brandId} onChange={(e) => setBrandId(e.target.value)} style={{ ...selectStyle, width: 140 }} title="Brand">
          <option value="">All brands</option>
          {opts.brands.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        <select value={locationId} onChange={(e) => setLocationId(e.target.value)} style={{ ...selectStyle, width: 150 }} title="Warehouse">
          <option value="">All warehouses</option>
          {opts.locations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        <select value={gender} onChange={(e) => setGender(e.target.value)} style={{ ...selectStyle, width: 110 }} title="Gender">
          <option value="">All genders</option>
          {opts.genders.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <input type="text" placeholder="Style code" value={styleCode} onChange={(e) => setStyleCode(e.target.value)} style={{ ...inputStyle, width: 120 }} />
        <input type="text" placeholder="Color" value={color} onChange={(e) => setColor(e.target.value)} style={{ ...inputStyle, width: 100 }} />
        <input type="text" placeholder="Size" value={size} onChange={(e) => setSize(e.target.value)} style={{ ...inputStyle, width: 80 }} />
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: C.textSub, display: "flex", alignItems: "center", gap: 6 }} title="Only layers this old or older (days)">
          Min age
          <input type="number" min={0} value={minAge} onChange={(e) => setMinAge(e.target.value)} style={{ ...inputStyle, width: 80 }} placeholder="d" />
        </label>
        <label style={{ fontSize: 12, color: C.textSub, display: "flex", alignItems: "center", gap: 6 }} title="Only layers in one age bucket">
          Bucket
          <select value={bucket} onChange={(e) => setBucket(e.target.value)} style={{ ...selectStyle, width: 130 }}>
            <option value="">All buckets</option>
            {labels.map((lab, i) => <option key={i} value={String(i + 1)}>{lab} days</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12, color: C.textSub, display: "flex", alignItems: "center", gap: 6 }} title="Slow movers: no sale in ≥ N days (includes never-sold)">
          Slow ≥
          <input type="number" min={0} value={slowDays} onChange={(e) => setSlowDays(e.target.value)} style={{ ...inputStyle, width: 80 }} placeholder="d" />
        </label>
        <label style={{ fontSize: 12, color: C.textSub, display: "flex", alignItems: "center", gap: 6 }} title="Only grains worth at least this much (at cost)">
          Min $
          <input type="number" min={0} value={minValue} onChange={(e) => setMinValue(e.target.value)} style={{ ...inputStyle, width: 90 }} placeholder="$" />
        </label>
        <label style={{ fontSize: 12, color: C.textSub, display: "flex", alignItems: "center", gap: 6 }} title="Only grains with at least this many units">
          Min qty
          <input type="number" min={0} value={minQty} onChange={(e) => setMinQty(e.target.value)} style={{ ...inputStyle, width: 80 }} />
        </label>
        <label style={{ fontSize: 12, color: C.textSub, display: "flex", alignItems: "center", gap: 6 }} title="Bucket cut-offs: 5 ascending day thresholds (comma-separated)">
          Buckets
          <input type="text" value={bucketsRaw} onChange={(e) => setBucketsRaw(e.target.value)} style={{ ...inputStyle, width: 140 }} placeholder="30,60,90,180,365" />
        </label>
        <label style={{ fontSize: 12, color: C.textSub, display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={includeZero} onChange={(e) => setIncludeZero(e.target.checked)} />
          Include zero on-hand
        </label>
        <button onClick={() => void load()} style={btnSecondary}>Refresh</button>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <input type="text" placeholder="Search results…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ ...inputStyle, width: 240 }} />
        <span style={{ color: C.textMuted, fontSize: 12 }}>{loading ? "Loading…" : `${filtered.length.toLocaleString()} rows · aged ${fmtDateDisplay(asOf)}`}</span>
        <div style={{ flex: 1 }} />
        <ExportButton rows={exportRows} filename={`inventory-aging-${groupBy}-${asOf}`} sheetName="Inventory Aging" columns={exportColumns} />
      </div>

      {err && <div style={{ color: C.danger, fontSize: 13, marginBottom: 10 }}>Error: {err}</div>}

      <div style={{ overflowX: "auto", border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 1400 }}>
          <thead>
            <tr>
              <SortableTh label={grainLabel} sortKey="grain_label" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
              <SortableTh label="On-hand" sortKey="on_hand_qty" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thR} cellStyle={{ textAlign: "right" }} />
              <SortableTh label="Value" sortKey="cost_value_cents" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thR} cellStyle={{ textAlign: "right" }} />
              <SortableTh label="Wavg age" sortKey="wavg_age_days" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thR} cellStyle={{ textAlign: "right" }} />
              <SortableTh label="Oldest" sortKey="oldest_age_days" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thR} cellStyle={{ textAlign: "right" }} />
              <th style={th}>Last recv</th>
              {labels.map((lab, i) => (
                i === 5
                  ? <SortableTh key={i} label={`${lab}`} sortKey="b6_value_cents" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thR} cellStyle={{ textAlign: "right" }} />
                  : <th key={i} style={thR}>{lab}</th>
              ))}
              <SortableTh label="Carry %/yr" sortKey="carry_pct" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thR} cellStyle={{ textAlign: "right" }} />
              <SortableTh label="Carry $/yr" sortKey="carry_annual" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thR} cellStyle={{ textAlign: "right" }} />
              <SortableTh label="Days since sale" sortKey="days_since_last_sale" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thR} cellStyle={{ textAlign: "right" }} />
              <SortableTh label="Wks supply" sortKey="weeks_of_supply" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thR} cellStyle={{ textAlign: "right" }} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.grain_key} onClick={() => void openDrill(r)} style={{ cursor: "pointer" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#172033")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                <td style={{ ...td, color: C.primary, fontWeight: 600 }}>
                  {r.grain_label}
                  {groupBy === "style_color" || groupBy === "sku"
                    ? <span style={{ color: C.textMuted, fontWeight: 400 }}>{r.size ? ` · ${r.size}` : ""}</span> : null}
                  {n(r.uncosted_qty) > 0 && (
                    <span title={`${fmtInt(r.uncosted_qty)} units have no cost on file (excluded from value)`}
                          style={{ marginLeft: 8, padding: "1px 6px", borderRadius: 10, fontSize: 10, fontWeight: 600, color: "#0b1220", background: C.warn }}>
                      {n(r.on_hand_qty) > 0 && n(r.uncosted_qty) >= n(r.on_hand_qty) ? "uncosted" : `${fmtInt(r.uncosted_qty)} uncosted`}
                    </span>
                  )}
                </td>
                <td style={tdR}>{fmtInt(r.on_hand_qty)}</td>
                <td style={tdR}>{fmtUsd0(r.cost_value_cents)}</td>
                <td style={tdR}>{fmtDays(r.wavg_age_days)}</td>
                <td style={{ ...tdR, color: n(r.oldest_age_days) > bucketDays[4] ? C.warn : C.text }}>{fmtDays(r.oldest_age_days)}</td>
                <td style={{ ...td, color: C.textSub }}>{r.last_received ? fmtDateDisplay(r.last_received) : "—"}</td>
                {[0, 1, 2, 3, 4, 5].map((i) => bucketCell(r, i))}
                <td style={tdR}>{fmtPct(r.carry_pct)}</td>
                <td style={{ ...tdR, color: C.purple }}>{fmtUsd0(n(r.int_annual_cents) + n(r.sto_annual_cents))}</td>
                <td style={{ ...tdR, color: r.days_since_last_sale == null ? C.danger : n(r.days_since_last_sale) > bucketDays[4] ? C.warn : C.text }}>
                  {r.days_since_last_sale == null ? "never" : fmtDays(r.days_since_last_sale)}
                </td>
                <td style={tdR}>{fmtWos(r.weeks_of_supply)}</td>
              </tr>
            ))}
            {!loading && sorted.length === 0 && (
              <tr><td colSpan={16} style={{ ...td, textAlign: "center", color: C.textMuted, padding: 24 }}>No inventory matches these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {drill && (
        <DrillModal row={drill} layers={layers} loading={drillLoading} asOf={asOf} grainLabel={grainLabel}
                    bucketDays={bucketDays} onClose={() => { setDrill(null); setLayers(null); }} />
      )}
    </div>
  );
}

function DrillModal({ row, layers, loading, asOf, grainLabel, bucketDays, onClose }: {
  row: Row; layers: Layer[] | null; loading: boolean; asOf: string; grainLabel: string; bucketDays: number[]; onClose: () => void;
}) {
  const totalQty = (layers || []).reduce((s, l) => s + n(l.remaining_qty), 0);
  const totalVal = (layers || []).reduce((s, l) => s + n(l.value_cents), 0);
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.bg, border: `1px solid ${C.cardBdr}`, borderRadius: 12, width: "min(1000px, 95vw)", maxHeight: "90vh", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.cardBdr}` }}>
          <div style={{ fontSize: 12, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>{grainLabel} · FIFO layers · aged {fmtDateDisplay(asOf)}</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.primary, marginTop: 2 }}>{row.grain_label}</div>
          <div style={{ fontSize: 12, color: C.textSub, marginTop: 4 }}>
            {fmtInt(totalQty)} units · {fmtUsd(totalVal)} at cost · wavg age {fmtDays(row.wavg_age_days)} · oldest {fmtDays(row.oldest_age_days)}
          </div>
        </div>
        <div style={{ overflow: "auto", padding: "0 20px", flex: 1 }}>
          {loading ? (
            <div style={{ padding: 24, color: C.textMuted }}>Loading layers…</div>
          ) : (layers && layers.length > 0) ? (
            <table style={{ borderCollapse: "collapse", width: "100%", marginTop: 12 }}>
              <thead>
                <tr>
                  <th style={th}>Last recv</th><th style={thR}>Age</th><th style={th}>SKU</th>
                  <th style={th}>Color</th><th style={th}>Size</th><th style={th}>Source</th><th style={th}>Warehouse</th>
                  <th style={thR}>On-hand</th><th style={thR}>Unit cost</th><th style={thR}>Value</th>
                </tr>
              </thead>
              <tbody>
                {layers.map((l) => {
                  const stale = l.age_days > bucketDays[4];
                  const mirrored = l.source_kind === "xoro_rest_size";
                  const effDiffers = l.eff_received && l.received_at && l.eff_received.slice(0, 10) !== l.received_at.slice(0, 10);
                  return (
                    <tr key={l.id}>
                      <td style={td} title={effDiffers ? `Snapshot ${fmtDateDisplay(l.received_at || "")} → last received ${fmtDateDisplay(l.eff_received || "")}` : undefined}>
                        {l.eff_received ? fmtDateDisplay(l.eff_received) : (l.received_at ? fmtDateDisplay(l.received_at) : "—")}
                        {mirrored ? <span style={{ color: C.textMuted, fontSize: 11 }}> (mirrored)</span> : null}
                      </td>
                      <td style={{ ...tdR, color: stale ? C.warn : C.text }}>{fmtDays(l.age_days)}</td>
                      <td style={{ ...td, color: C.textSub }}>{l.sku_code || "—"}</td>
                      <td style={td}>{l.color || "—"}</td>
                      <td style={td}>{l.size || "—"}</td>
                      <td style={{ ...td, color: C.textSub }}>{l.source_kind || "—"}</td>
                      <td style={{ ...td, color: C.textSub }}>{l.location_name || "—"}</td>
                      <td style={tdR}>{fmtInt(l.remaining_qty)}</td>
                      <td style={{ ...tdR, color: l.is_uncosted ? C.warn : C.text }}>
                        {l.is_uncosted ? "no cost" : fmtUsd(l.eff_unit_cost_cents)}
                      </td>
                      <td style={tdR}>{l.is_uncosted ? "—" : fmtUsd(l.value_cents)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div style={{ padding: 24, color: C.textMuted }}>No open FIFO layers for this grain as of {fmtDateDisplay(asOf)}.</div>
          )}
        </div>
        <div style={{ padding: "12px 20px", borderTop: `1px solid ${C.cardBdr}`, display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button onClick={onClose} style={btnSecondary}>Close</button>
        </div>
      </div>
    </div>
  );
}
