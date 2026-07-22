// src/tanda/InternalCutoverRecon.tsx
//
// Tangerine — Cutover Reconciliation (Admin). One screen proving Tangerine
// matches the Xoro mirror across six domains (Inventory, Sales Orders, Purchase
// Orders, AR, AP, GL) so the gaps can be watched down to zero before the
// Xoro -> Tangerine cutover. Read-only. Backed by GET /api/internal/cutover-recon
// which runs one bounded jsonb tie-out per domain (migration 20267700000000).
// Sibling of Sync Health — Sync Health proves the feeds FLOW; this proves the
// numbers TIE.

import { useCallback, useEffect, useMemo, useState } from "react";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";

type Kind =
  | "match" | "missing_in_mirror" | "missing_in_native" | "value_mismatch" | "status_mismatch";

type Variance = {
  key: string; kind: Kind;
  native_present?: boolean; mirror_present?: boolean;
  native_value?: number | null; mirror_value?: number | null;
  native_status?: string | null; mirror_status?: string | null;
  // domain extras
  gl_name?: string; style_code?: string; color?: string; size?: string;
  divergence_units?: number; exposure_cents?: number; severity?: string;
  reclass?: number; unmirrored?: number; residual_core?: number;
};

type Section = {
  domain: string; label: string;
  status: "pass" | "fail" | "unavailable";
  headline_metrics: Record<string, number | string | null>;
  variances: Variance[];
  variance_total: number;
  truncated: boolean;
  note: string | null;
};

type Report = {
  generated_at: string;
  overall_status: "pass" | "fail" | "unavailable";
  domains_total: number; domains_passing: number; domains_failing: number;
  sections: Section[];
};

const C = {
  bg: "#0b1220", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8",
  success: "#10B981", danger: "#EF4444", warn: "#F59E0B", blue: "#3B82F6",
};

const th: React.CSSProperties = { background: C.bg, color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5, whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const tdNum: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };

const fmtInt = (n: unknown) => (n == null ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }));
const fmtCents = (n: unknown) => (n == null ? "—" : (Number(n) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" }));
const fmtDollars = (n: unknown) => (n == null ? "—" : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }));
const fmtDate = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
};
const fmtDateTime = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const KIND_LABEL: Record<Kind, string> = {
  match: "Tied",
  missing_in_mirror: "In Tangerine, not Xoro",
  missing_in_native: "In Xoro, not Tangerine",
  value_mismatch: "Amount differs",
  status_mismatch: "Status differs",
};
const kindColor = (k: Kind) => (k === "match" ? C.success : k === "status_mismatch" ? C.warn : C.danger);

// Human labels for the headline metric keys, per domain (order matters).
const HEADLINE_LABELS: Record<string, [string, string, (v: unknown) => string][]> = {
  inventory: [
    ["layers_units", "Tangerine layer units", fmtInt],
    ["rest_units", "Xoro REST units", fmtInt],
    ["unit_divergence", "Abs unit divergence", fmtInt],
    ["layers_value_cents", "Layer value @ cost", fmtCents],
    ["exposure_cents", "Divergence @ cost", fmtCents],
    ["skus_divergent", "Divergent SKUs", fmtInt],
    ["skus_material", "Material SKUs", fmtInt],
  ],
  sales_orders: [
    ["native_open_count", "Native open SOs", fmtInt],
    ["mirror_active_count", "Xoro active SOs", fmtInt],
    ["native_open_qty", "Native open qty", fmtInt],
    ["mirror_active_qty", "Xoro active qty", fmtInt],
    ["variance_count", "Variances", fmtInt],
  ],
  purchase_orders: [
    ["native_inbound_count", "Native inbound POs", fmtInt],
    ["mirror_inbound_count", "Xoro inbound POs", fmtInt],
    ["native_inbound_qty", "Native inbound qty", fmtInt],
    ["mirror_inbound_qty", "Xoro inbound qty", fmtInt],
    ["variance_count", "Variances", fmtInt],
  ],
  ar: [
    ["native_open_count", "Native open invoices", fmtInt],
    ["native_open_cents", "Native open balance", fmtCents],
    ["mirror_open_count", "Xoro flagged open", fmtInt],
    ["matched_count", "Both open", fmtInt],
    ["native_open_not_mirror", "Native open, Xoro not", fmtInt],
    ["mirror_open_not_native", "Xoro open, native not", fmtInt],
  ],
  ap: [
    ["native_open_count", "Native open bills", fmtInt],
    ["native_open_cents", "Native open balance", fmtCents],
    ["in_feed_count", "In Xoro AP feed", fmtInt],
    ["amount_matched_count", "Amount tied", fmtInt],
    ["amount_mismatch_count", "Amount differs", fmtInt],
    ["missing_from_feed_count", "Newer than feed", fmtInt],
    ["ap_control_residual_cents", "AP control residual", fmtCents],
  ],
  gl: [
    ["accounts_total", "Accounts", fmtInt],
    ["accounts_tied", "Tied", fmtInt],
    ["accounts_broken", "Breaks", fmtInt],
    ["abs_residual_cents", "Abs unexplained residual", fmtCents],
    ["net_residual_cents", "Net residual", fmtCents],
  ],
};

// One-line card summary per domain.
function cardSummary(s: Section): string {
  const h = s.headline_metrics;
  switch (s.domain) {
    case "inventory": return `${fmtInt(h.skus_divergent)} divergent SKUs (${fmtInt(h.skus_material)} material), ${fmtCents(h.exposure_cents)} @ cost`;
    case "sales_orders": return `${fmtInt(h.native_open_count)} native vs ${fmtInt(h.mirror_active_count)} Xoro; ${fmtInt(h.variance_count)} gaps`;
    case "purchase_orders": return `${fmtInt(h.native_inbound_count)} native vs ${fmtInt(h.mirror_inbound_count)} Xoro; ${fmtInt(h.variance_count)} gaps`;
    case "ar": return `${fmtInt(h.native_open_count)} native open (${fmtCents(h.native_open_cents)}); ${fmtInt(s.variance_total)} set gaps`;
    case "ap": return `${fmtInt(h.native_open_count)} open bills (${fmtCents(h.native_open_cents)}); ${fmtInt(s.variance_total)} not tied`;
    case "gl": return `${fmtInt(h.accounts_broken)} of ${fmtInt(h.accounts_total)} accounts broken; ${fmtCents(h.abs_residual_cents)} residual`;
    default: return `${fmtInt(s.variance_total)} variances`;
  }
}

// Variance table column config per domain: [header, render]. Keys are read off
// the Variance row. Kept small + readable; no raw UUIDs (keys are business ids).
type Col = { header: string; render: (v: Variance) => string; num?: boolean };
function columnsFor(domain: string): Col[] {
  const kindCol: Col = { header: "Classification", render: (v) => KIND_LABEL[v.kind] ?? v.kind };
  switch (domain) {
    case "inventory": return [
      { header: "SKU", render: (v) => v.key },
      { header: "Style", render: (v) => v.style_code ?? "" },
      { header: "Color / Size", render: (v) => [v.color, v.size].filter(Boolean).join(" / ") },
      { header: "Layers", render: (v) => fmtInt(v.native_value), num: true },
      { header: "REST", render: (v) => fmtInt(v.mirror_value), num: true },
      { header: "Divergence", render: (v) => fmtInt(v.divergence_units), num: true },
      { header: "Exposure @ cost", render: (v) => fmtCents(v.exposure_cents), num: true },
      { header: "Severity", render: (v) => v.severity ?? "" },
    ];
    case "sales_orders":
    case "purchase_orders": return [
      { header: domain === "sales_orders" ? "SO #" : "PO #", render: (v) => v.key },
      { header: "Native qty", render: (v) => fmtInt(v.native_value), num: true },
      { header: "Xoro qty", render: (v) => fmtInt(v.mirror_value), num: true },
      { header: "Native status", render: (v) => v.native_status ?? "—" },
      { header: "Xoro status", render: (v) => v.mirror_status ?? "—" },
      kindCol,
    ];
    case "ar": return [
      { header: "Invoice #", render: (v) => v.key },
      { header: "Native open bal", render: (v) => fmtCents(v.native_value), num: true },
      { header: "Native", render: (v) => (v.native_present ? "open" : "—") },
      { header: "Xoro", render: (v) => v.mirror_status ?? "—" },
      kindCol,
    ];
    case "ap": return [
      { header: "Bill #", render: (v) => v.key },
      { header: "Native open bal", render: (v) => fmtCents(v.native_value), num: true },
      { header: "Xoro AP feed", render: (v) => (v.mirror_value == null ? "—" : fmtCents(v.mirror_value)), num: true },
      { header: "Xoro status", render: (v) => v.mirror_status ?? "—" },
      kindCol,
    ];
    case "gl": return [
      { header: "Account", render: (v) => `${v.key} — ${v.gl_name ?? ""}` },
      { header: "Tangerine", render: (v) => fmtDollars(v.native_value), num: true },
      { header: "Xoro", render: (v) => fmtDollars(v.mirror_value), num: true },
      { header: "Reclass", render: (v) => fmtDollars(v.reclass), num: true },
      { header: "Unmirrored", render: (v) => fmtDollars(v.unmirrored), num: true },
      { header: "Unexplained", render: (v) => fmtDollars(v.residual_core), num: true },
    ];
    default: return [
      { header: "Key", render: (v) => v.key },
      { header: "Native", render: (v) => fmtInt(v.native_value), num: true },
      { header: "Xoro", render: (v) => fmtInt(v.mirror_value), num: true },
      kindCol,
    ];
  }
}

function exportColumnsFor(domain: string): ExportColumn[] {
  const base: ExportColumn[] = [
    { key: "key", header: "Identifier" },
    { key: "kind", header: "Classification" },
    { key: "native_value", header: "Native", format: "number", digits: 2 },
    { key: "mirror_value", header: "Xoro", format: "number", digits: 2 },
    { key: "native_status", header: "Native status" },
    { key: "mirror_status", header: "Xoro status" },
  ];
  if (domain === "gl") return [
    { key: "key", header: "Account code" }, { key: "gl_name", header: "Account name" },
    { key: "native_value", header: "Tangerine", format: "currency_dollars" },
    { key: "mirror_value", header: "Xoro", format: "currency_dollars" },
    { key: "reclass", header: "Reclass", format: "currency_dollars" },
    { key: "unmirrored", header: "Unmirrored", format: "currency_dollars" },
    { key: "residual_core", header: "Unexplained", format: "currency_dollars" },
  ];
  if (domain === "inventory") return [
    { key: "key", header: "SKU" }, { key: "style_code", header: "Style" },
    { key: "color", header: "Color" }, { key: "size", header: "Size" },
    { key: "native_value", header: "Layers units", format: "number" },
    { key: "mirror_value", header: "REST units", format: "number" },
    { key: "divergence_units", header: "Divergence", format: "number" },
    { key: "exposure_cents", header: "Exposure", format: "currency_cents" },
    { key: "severity", header: "Severity" },
  ];
  return base;
}

const glyph = (status: Section["status"]) =>
  status === "pass" ? "✓" : status === "unavailable" ? "◐" : "✕";
const statusColor = (status: Section["status"]) =>
  status === "pass" ? C.success : status === "unavailable" ? C.warn : C.danger;

export default function InternalCutoverRecon() {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const r = await fetch("/api/internal/cutover-recon");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setReport((await r.json()) as Report);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const sections = report?.sections ?? [];

  return (
    <div style={{ padding: 20, maxWidth: 1280 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4, flexWrap: "wrap" }}>
        <h2 style={{ color: C.text, margin: 0, fontSize: 18 }}>Cutover Reconciliation</h2>
        <button type="button" onClick={() => void load()} style={{ background: C.card, color: C.text, border: `1px solid ${C.cardBdr}`, borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12 }}>Refresh</button>
        {report && <span style={{ color: C.textMuted, fontSize: 12 }}>Run {fmtDateTime(report.generated_at)}</span>}
      </div>
      <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 16, maxWidth: 900 }}>
        Every domain ties Tangerine's operational tables to the Xoro mirror feeds. Run it any day and watch the
        gaps burn to zero before go-live. A card is green (✓) only when its gaps reach zero; amber (◐) means the
        mirror lacks the data to tie fully (see the note on that section).
      </div>

      {err && <div style={{ color: C.danger, marginBottom: 12 }}>Failed to load: {err}</div>}
      {loading && <div style={{ color: C.textMuted }}>Running six tie-outs…</div>}

      {report && (
        <>
          {/* PASS / FAIL card row */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12, marginBottom: 24 }}>
            {sections.map((s) => (
              <a key={s.domain} href={`#recon-${s.domain}`} style={{ textDecoration: "none" }}>
                <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderLeft: `4px solid ${statusColor(s.status)}`, borderRadius: 10, padding: "12px 14px", height: "100%" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: statusColor(s.status), fontWeight: 800, fontSize: 16 }}>{glyph(s.status)}</span>
                    <span style={{ color: C.text, fontWeight: 700, fontSize: 14 }}>{s.label}</span>
                  </div>
                  <div style={{ color: C.textMuted, fontSize: 12, marginTop: 6, lineHeight: 1.4 }}>{cardSummary(s)}</div>
                </div>
              </a>
            ))}
          </div>

          {sections.map((s) => (
            <DomainSection key={s.domain} s={s} />
          ))}
        </>
      )}
    </div>
  );
}

function DomainSection({ s }: { s: Section }) {
  const cols = useMemo(() => columnsFor(s.domain), [s.domain]);
  const exportCols = useMemo(() => exportColumnsFor(s.domain), [s.domain]);
  const headlineRows = HEADLINE_LABELS[s.domain] ?? [];

  return (
    <div id={`recon-${s.domain}`} style={{ scrollMarginTop: 16, marginBottom: 28 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ color: statusColor(s.status), fontWeight: 800, fontSize: 15 }}>{glyph(s.status)}</span>
        <h3 style={{ color: C.text, margin: 0, fontSize: 16 }}>{s.label}</h3>
        <span style={{ color: statusColor(s.status), fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>{s.status}</span>
        <div style={{ flex: 1 }} />
        {s.variances.length > 0 && (
          <ExportButton rows={s.variances as unknown as Record<string, unknown>[]} columns={exportCols} filename={`cutover-recon-${s.domain}`} />
        )}
      </div>

      {/* headline metric chips */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        {headlineRows.map(([k, label, fmt]) => (
          <div key={k} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: "6px 10px", minWidth: 120 }}>
            <div style={{ color: C.textMuted, fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
            <div style={{ color: C.text, fontSize: 15, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fmt(s.headline_metrics[k])}</div>
          </div>
        ))}
      </div>

      {s.note && (
        <div style={{ color: C.textMuted, fontSize: 12, marginBottom: 10, fontStyle: "italic", maxWidth: 900, lineHeight: 1.5 }}>{s.note}</div>
      )}

      {s.variances.length === 0 ? (
        <div style={{ color: C.success, fontSize: 13, padding: "8px 0" }}>No variances — tied.</div>
      ) : (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: "8px 12px", color: C.textMuted, fontSize: 12, borderBottom: `1px solid ${C.cardBdr}` }}>
            Showing {s.variances.length.toLocaleString("en-US")} of {s.variance_total.toLocaleString("en-US")} {s.truncated ? "(top by size)" : ""}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead><tr>{cols.map((c) => <th key={c.header} style={{ ...th, textAlign: c.num ? "right" : "left" }}>{c.header}</th>)}</tr></thead>
              <tbody>
                {s.variances.map((v, i) => (
                  <tr key={`${v.key}-${i}`}>
                    {cols.map((c, ci) => (
                      <td key={c.header} style={c.num ? tdNum : ci === 0 ? { ...td, color: C.text, fontFamily: "Consolas, monospace", whiteSpace: "nowrap" } : (c.header === "Classification" ? { ...td, color: kindColor(v.kind), fontWeight: 600 } : td)}>
                        {c.render(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
