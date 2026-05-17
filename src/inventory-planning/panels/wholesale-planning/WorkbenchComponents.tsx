// Standalone components extracted from WholesalePlanningWorkbench.tsx:
// summary cards + loading overlays + collapse chevron. Pulled out so
// the main Workbench component reads more like an orchestrator and so
// these reusable pieces are easy to find.

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { IpPlanningGridRow } from "../../types/wholesale";
import { S, PAL, formatPeriodCode } from "../../components/styles";
import OpStatusOverlay from "../../../shared/ui/OpStatusOverlay";

export function MonthlyTotalsCards({ rows, systemSuggestionsOn }: { rows: IpPlanningGridRow[]; systemSuggestionsOn: boolean }) {
  const totals = useMemo(() => {
    type Bucket = {
      buyQty: number; buyDollars: number;
      forecastQty: number; forecastDollars: number;
    };
    const months = new Map<string, Bucket>();
    let totalBuyQty = 0, totalBuyD = 0, totalFcQty = 0, totalFcD = 0;
    for (const r of rows) {
      const m = r.period_code;
      let b = months.get(m);
      if (!b) { b = { buyQty: 0, buyDollars: 0, forecastQty: 0, forecastDollars: 0 }; months.set(m, b); }
      const buy = r.planned_buy_qty ?? 0;
      const cost = r.unit_cost ?? r.avg_cost ?? 0;
      // Match the grid's mute logic: when system suggestions are OFF,
      // forecast = max(0, buyer + override). Otherwise use the
      // service-computed final_forecast_qty as-is.
      const finalEff = systemSuggestionsOn
        ? r.final_forecast_qty
        : Math.max(0, r.buyer_request_qty + r.override_qty);
      b.buyQty += buy;
      b.buyDollars += buy * cost;
      b.forecastQty += finalEff;
      b.forecastDollars += finalEff * cost;
      totalBuyQty += buy;
      totalBuyD += buy * cost;
      totalFcQty += finalEff;
      totalFcD += finalEff * cost;
    }
    const sorted = Array.from(months.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    return { sorted, totalBuyQty, totalBuyD, totalFcQty, totalFcD };
  }, [rows, systemSuggestionsOn]);

  const fmtUnits = (n: number) => Math.round(n).toLocaleString();
  // Round dollars UP to the nearest $1,000 and render with no decimal
  // — the planner reads totals at a glance, the cents are noise.
  // Sub-$1,000 totals still surface so a near-zero plan reads "$0".
  const fmtUsd = (n: number) => {
    if (n <= 0) return "$0";
    const ceiled = Math.ceil(n / 1000) * 1000;
    return `$${ceiled.toLocaleString()}`;
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
      <SummaryCard
        title="Total Buy"
        accent={PAL.green}
        totalUnits={totals.totalBuyQty}
        totalDollars={totals.totalBuyD}
        rows={totals.sorted.map(([m, b]) => ({ month: m, units: b.buyQty, dollars: b.buyDollars }))}
        fmtUnits={fmtUnits}
        fmtUsd={fmtUsd}
      />
      <SummaryCard
        title="Final Forecast"
        accent={PAL.accent2}
        totalUnits={totals.totalFcQty}
        totalDollars={totals.totalFcD}
        rows={totals.sorted.map(([m, b]) => ({ month: m, units: b.forecastQty, dollars: b.forecastDollars }))}
        fmtUnits={fmtUnits}
        fmtUsd={fmtUsd}
      />
    </div>
  );
}

export function SummaryCard({
  title, accent, totalUnits, totalDollars, rows, fmtUnits, fmtUsd,
}: {
  title: string;
  accent: string;
  totalUnits: number;
  totalDollars: number;
  rows: Array<{ month: string; units: number; dollars: number }>;
  fmtUnits: (n: number) => string;
  fmtUsd: (n: number) => string;
}) {
  return (
    <div style={{ ...S.card, padding: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: PAL.textMuted, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase" }}>{title}</div>
        <div style={{ display: "flex", gap: 16 }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 10, color: PAL.textMuted }}>Total units</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: accent, fontFamily: "monospace" }}>{fmtUnits(totalUnits)}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 10, color: PAL.textMuted }}>Total $</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: accent, fontFamily: "monospace" }}>{fmtUsd(totalDollars)}</div>
          </div>
        </div>
      </div>
      {rows.length === 0 ? (
        <div style={{ color: PAL.textMuted, fontSize: 12, fontStyle: "italic", padding: 8 }}>
          No data yet — build a forecast and add Buy quantities.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1.2fr repeat(2, 1fr)", gap: 4, fontSize: 12 }}>
          <div style={{ color: PAL.textMuted, fontWeight: 600 }}>Month</div>
          <div style={{ color: PAL.textMuted, fontWeight: 600, textAlign: "right" }}>Units</div>
          <div style={{ color: PAL.textMuted, fontWeight: 600, textAlign: "right" }}>$</div>
          {rows.map((r) => (
            <Fragment key={r.month}>
              <div style={{ color: PAL.textDim }}>{formatPeriodCode(r.month)}</div>
              <div style={{ textAlign: "right", fontFamily: "monospace", color: r.units > 0 ? PAL.text : PAL.textMuted }}>
                {r.units > 0 ? fmtUnits(r.units) : "—"}
              </div>
              <div style={{ textAlign: "right", fontFamily: "monospace", color: r.dollars > 0 ? PAL.text : PAL.textMuted }}>
                {r.dollars > 0 ? fmtUsd(r.dollars) : "—"}
              </div>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

// Thin wrapper over the shared OpStatusOverlay — preserves the local
// {label, message, canCancel, onCancel} call shape used throughout
// the workbench so call sites didn't have to be chased down. The
// shared overlay handles the modal frame, indeterminate animation,
// gradient bar, and cancel-button styling.
export function OperationStatusBar({ label, message, canCancel, onCancel }: {
  label: string;
  message?: string;
  canCancel?: boolean;
  onCancel: () => void;
}) {
  return (
    <OpStatusOverlay
      label={label}
      message={message}
      canCancel={canCancel}
      onCancel={onCancel}
    />
  );
}

export function BootstrapStatusBar({ phase, onCancel }: { phase: "masters" | "run-data" | "ready"; onCancel: () => void }) {
  const PHASE_LABELS: Record<string, string> = {
    "masters": "Loading customers and items…",
    "run-data": "Loading forecast and inventory…",
    "ready": "",
  };
  // Asymptotic easing per phase. Each phase has a [low, high] band and
  // a tau (seconds): pct rises from low toward high as
  // 1 − exp(−elapsed/tau), which feels fast at first then slows as it
  // nears the cap. This keeps the bar moving through the slow
  // run-data step (~10s of buildGridRows reads) instead of snapping to
  // 75% and freezing. Estimated durations are based on observed timing:
  // masters resolves in ~1.5s, run-data in ~8–12s.
  const PHASE_BAND: Record<string, { low: number; high: number; tau: number }> = {
    "masters":  { low: 0,  high: 28, tau: 0.7 },
    "run-data": { low: 28, high: 94, tau: 4.5 },
    "ready":    { low: 100, high: 100, tau: 0.1 },
  };
  const [pct, setPct] = useState(0);
  const phaseStartRef = useRef<{ phase: string; t0: number; basePct: number }>({ phase, t0: performance.now(), basePct: 0 });

  // On phase change, anchor the easing curve at the current pct so the
  // bar continues smoothly from where it was instead of snapping back.
  useEffect(() => {
    phaseStartRef.current = { phase, t0: performance.now(), basePct: pct };
    if (phase === "ready") setPct(100);
    // Intentionally exclude `pct` — anchor only when phase flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => {
    if (phase === "ready") return;
    let raf = 0;
    const tick = () => {
      const { t0, basePct } = phaseStartRef.current;
      const band = PHASE_BAND[phase];
      const elapsedSec = (performance.now() - t0) / 1000;
      // Eased target within this phase's band.
      const eased = band.low + (band.high - band.low) * (1 - Math.exp(-elapsedSec / band.tau));
      // Never go backwards, never exceed band.high − tiny gap so we
      // visibly hand off to the next phase rather than touch the cap.
      const next = Math.min(band.high - 0.5, Math.max(basePct, eased));
      setPct(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: PAL.panel, borderRadius: 14, padding: "28px 32px", width: 380, maxWidth: "92vw", border: `1px solid ${PAL.border}`, boxSizing: "border-box", boxShadow: "0 8px 24px rgba(0,0,0,0.18)" }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: PAL.text, marginBottom: 8 }}>Loading…</div>
        <div style={{ fontSize: 13, color: PAL.textMuted, marginBottom: 20 }}>{PHASE_LABELS[phase]}</div>
        <div style={{ background: PAL.panelAlt, borderRadius: 8, height: 10, overflow: "hidden", marginBottom: 20, border: `1px solid ${PAL.borderFaint}` }}>
          <div style={{ height: "100%", borderRadius: 8, background: `linear-gradient(90deg,${PAL.green},${PAL.accent})`, width: `${pct}%`, transition: "width 0.15s linear" }} />
        </div>
        <button
          style={{ background: "none", border: `1px solid ${PAL.red}`, color: PAL.red, borderRadius: 6, padding: "7px 18px", fontSize: 13, cursor: "pointer", width: "100%" }}
          onClick={onCancel}
        >
          Stop
        </button>
      </div>
    </div>
  );
}

// Small ▾ / ▸ button absolutely positioned at the top-right of a card.
// Clicking flips the parent's collapse state. Intentionally minimal —
// the parent decides what to render when collapsed (an empty space, a
// hint message, or fully gone).
export function CollapseChevron({ collapsed, onToggle, label }: {
  collapsed: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={collapsed ? `Expand ${label}` : `Collapse ${label}`}
      aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
      style={{
        position: "absolute",
        top: 6,
        right: 6,
        width: 22,
        height: 22,
        padding: 0,
        background: "transparent",
        border: `1px solid ${PAL.border}`,
        color: PAL.textDim,
        borderRadius: 4,
        fontSize: 11,
        lineHeight: 1,
        cursor: "pointer",
        fontFamily: "inherit",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2,
      }}
    >
      {collapsed ? "▸" : "▾"}
    </button>
  );
}
