// Presentational <tr> for one Wholesale Planning grid row. Extracted
// from the inline 340-line body inside WholesalePlanningGrid.tsx so
// the rendering can be unit-tested + so the parent's map() body
// shrinks back to one component call.
//
// Every closure variable from the old IIFE map body is now an
// explicit prop. The parent computes derived state once per row
// (isChild, isExpanded, aggExpansionKey) so this component doesn't
// need access to expandedAggs/childIds Sets. Saving handlers
// (saveAggBuy, saveAggBuyerOrOverride, openSummaryCtx) stay in the
// parent because they close over scrolling refs + setState; we just
// receive their bound thunks.
//
// All visual logic (aggregate tint, NEW-style badge gating, color-
// edit blocking) is unchanged — pure copy of the original JSX.

import type React from "react";
import type { IpPlanningGridRow } from "../../types/wholesale";
import { S, PAL, ACTION_COLOR, CONFIDENCE_COLOR, METHOD_COLOR, METHOD_LABEL, formatQty, formatPeriodCode } from "../../components/styles";
import { StatCell } from "../../components/StatCell";
import { BuyCell } from "../../components/cells/BuyCell";
import { IntCell } from "../../components/cells/IntCell";
import { UnitCostCell } from "../../components/cells/UnitCostCell";
import { SystemCell } from "../../components/cells/SystemCell";
import { TbdStyleCell } from "../../components/cells/TbdStyleCell";
import { TbdDescriptionCell } from "../../components/cells/TbdDescriptionCell";
import { TbdCustomerCell } from "../../components/cells/TbdCustomerCell";
import { TbdColorCell } from "../../components/cells/TbdColorCell";
import { buildStyleCellContext, buildColorCellContext, type MasterStyle } from "./tbdRowHelpers";

// `StatCell` is imported only to satisfy a stray reference in the old
// JSX in case it gets revived; remove if still unused after merge.
void StatCell;

type SummaryCol = "onHand" | "onOrder" | "onPO";

export interface PlanningGridRowProps {
  row: IpPlanningGridRow;
  /** Pre-computed inside the parent map. */
  isChild: boolean;
  /** Pre-computed inside the parent map. */
  isExpanded: boolean;
  /** Pre-computed inside the parent map (aggregate_key ?? forecast_id). */
  aggExpansionKey: string;

  /** Explode-PPK toggle state. When OFF, the editable qty cells display + accept
   *  PACK counts, so a typed value is multiplied back to eaches on save. */
  explodePpk: boolean;
  /** Units-per-pack for this row, resolved by the parent from the SKU/size
   *  "PPKn" token first, then Tangerine's Prepack Matrix. 1 = not a prepack (or
   *  unresolved). Drives round-to-pack and the packs ⇄ eaches save conversion. */
  packSize: number;
  /** True when the row is a prepack (carries a PPK token) but no pack size could
   *  be resolved from the token OR Tangerine's matrix — surfaces a ⚠ warning so
   *  the planner sets up the Prepack Matrix in Tangerine. */
  ppkUnresolved: boolean;
  /** Toolbar carton qty (default 24). On a NON-prepack row, entered quantities
   *  round UP to the next whole carton. PPK styles use their pack size instead
   *  (packSize wins); a carton qty of 0/1 disables the rounding. */
  cartonQty: number;

  /** Master + planner-added reference data. */
  rows: IpPlanningGridRow[];
  masterStyles?: MasterStyle[];
  masterColorsLower?: Set<string>;
  masterColorsByStyleLower?: Map<string, Set<string>>;
  allKnownColorsLower: Set<string>;
  colorsByGroupName: Map<string, Set<string>>;
  knownDescriptions: string[];
  masterDescriptionsLower: Set<string>;
  customers: Array<{ id: string; name: string }>;
  newCustomerIds?: Set<string>;

  /** Display state */
  hiddenColumns: Set<string>;

  /** Callbacks. */
  onSelectRow: (row: IpPlanningGridRow) => void;
  toggleAggExpanded: (key: string) => void;
  setColorEditBlocked: (b: boolean) => void;
  onUpdateTbdStyle?: (row: IpPlanningGridRow, styleCode: string) => Promise<void>;
  onUpdateTbdDescription?: (row: IpPlanningGridRow, desc: string) => Promise<void>;
  onUpdateTbdColor?: (row: IpPlanningGridRow, color: string, isNew: boolean) => Promise<void>;
  onUpdateTbdCustomer?: (row: IpPlanningGridRow, id: string, name: string) => Promise<void>;
  onAddTbdNewCustomer?: (row: IpPlanningGridRow, name: string) => Promise<void>;
  onDeleteTbdRow?: (row: IpPlanningGridRow) => Promise<void>;
  // Promote a planner-added new style+color into the company masters
  // (ip_item_master + style_master) so it's visible in Tangerine + ATS.
  onPromoteTbdRow?: (row: IpPlanningGridRow) => Promise<void>;
  // style|color keys already promoted this session — flips the button to a
  // read-only "✓ in DB" so the planner doesn't re-promote.
  promotedTbdKeys?: Set<string>;
  onUpdateSystemOverride: (forecastId: string, qty: number | null) => Promise<void>;
  onUpdateUnitCost: (forecastId: string, cost: number | null) => Promise<void>;
  // Fan a Unit Cost out to every child of an aggregate row (single rows
  // save directly). Used by the editable Unit Cost cell on ALL rows.
  saveAggUnitCost: (row: IpPlanningGridRow, cost: number | null) => Promise<void>;
  saveAggBuyerOrOverride: (
    row: IpPlanningGridRow,
    qty: number,
    field: "buyer_request_qty" | "override_qty",
    onUpdate: (forecastId: string, qty: number | null) => Promise<void>,
    isOverride: boolean,
  ) => Promise<void>;
  saveAggBuy: (row: IpPlanningGridRow, qty: number | null) => Promise<void>;
  openSummaryCtx: (e: React.MouseEvent, col: SummaryCol, row: IpPlanningGridRow) => Promise<void> | void;

  /** Bound updaters passed straight through (used inside saveAggBuyerOrOverride). */
  onUpdateBuyerRequest: (forecastId: string, qty: number | null) => Promise<void>;
  onUpdateOverride: (forecastId: string, qty: number | null) => Promise<void>;
}

export function PlanningGridRow(props: PlanningGridRowProps) {
  const {
    row: r,
    isChild,
    isExpanded,
    aggExpansionKey,
    explodePpk,
    packSize,
    ppkUnresolved,
    cartonQty,
    rows,
    masterStyles,
    masterColorsLower,
    masterColorsByStyleLower,
    allKnownColorsLower,
    colorsByGroupName,
    knownDescriptions,
    masterDescriptionsLower,
    customers,
    newCustomerIds,
    hiddenColumns,
    onSelectRow,
    toggleAggExpanded,
    setColorEditBlocked,
    onUpdateTbdStyle,
    onUpdateTbdDescription,
    onUpdateTbdColor,
    onUpdateTbdCustomer,
    onAddTbdNewCustomer,
    onDeleteTbdRow,
    onPromoteTbdRow,
    promotedTbdKeys,
    onUpdateSystemOverride,
    onUpdateUnitCost,
    saveAggUnitCost,
    saveAggBuyerOrOverride,
    saveAggBuy,
    openSummaryCtx,
    onUpdateBuyerRequest,
    onUpdateOverride,
  } = props;

  const colHide = (key: string): React.CSSProperties | undefined =>
    hiddenColumns.has(key) ? { display: "none" } : undefined;

  // Round a quantity UP to the next whole multiple of `unit` (sign-aware, so
  // negative overrides round away from zero). unit ≤ 1 or a 0/null qty passes
  // through untouched.
  const roundUp = (qty: number | null, unit: number): number | null => {
    if (unit <= 1 || qty == null || qty === 0) return qty;
    const sign = qty < 0 ? -1 : 1;
    return sign * Math.ceil(Math.abs(qty) / unit) * unit;
  };
  // The rounding unit for THIS row: a prepack's pack size wins (from token or
  // Tangerine matrix); otherwise the toolbar carton qty applies to the plain
  // style. So PPK-24 rounds to 24, a non-prepack style rounds to the carton
  // qty (default 24), and cartonQty 0/1 means no rounding on non-PPK rows.
  const cartonUnit = cartonQty > 1 ? cartonQty : 1;
  // Turn an edited cell value into the STORED eaches quantity. When Explode is
  // OFF a PPK cell is in PACK grain, so the typed value is multiplied back up to
  // eaches; otherwise the value is already eaches and is rounded UP to a whole
  // pack (PPK: 1,190 → 1,200) or a whole carton (non-PPK). Applied to
  // System / Buyer / Override / Buy.
  const toStoredEaches = (typed: number | null): number | null => {
    if (typed == null) return null;
    if (!explodePpk && packSize > 1) return typed * packSize; // PPK packs → eaches
    if (packSize > 1) return roundUp(typed, packSize);        // PPK (explode on) → pack
    return roundUp(typed, cartonUnit);                        // non-PPK → carton
  };

  // Aggregate row visual treatment — distinctly tinted from the panel
  // background so the planner can spot rolled-up rows at a glance,
  // with a left accent bar that intensifies when expanded.
  const aggBg = isExpanded
    ? `${PAL.accent}26`     // blue ~15% — drilled-in
    : `${PAL.accent2}1F`;   // green ~12% — rolled-up
  const aggBar = isExpanded ? PAL.accent : `${PAL.accent2}99`;

  return (
    <tr
      className="planning-grid-row"
      data-agg={r.is_aggregate ? "1" : undefined}
      onContextMenu={(e) => { e.preventDefault(); if (!r.is_aggregate) onSelectRow(r); }}
      title={
        r.is_user_added ? "Planner-added TBD row — click ✕ at the row tail to delete"
        : r.is_aggregate ? "Click chevron to drill in"
        : "Right-click for more info"
      }
      style={
        // is_user_added wins over the other tints because the planner
        // needs to spot their own rows quickly even when they're
        // aggregates of multiple sizes.
        r.is_user_added ? {
          background: `${PAL.accent2}11`,
          boxShadow: `inset 4px 0 0 ${PAL.accent2}`,
        }
        : r.is_aggregate ? {
          background: aggBg,
          boxShadow: `inset 3px 0 0 ${aggBar}`,
          color: PAL.textDim,
          fontWeight: 700,
          fontStyle: "italic",
          textDecoration: "underline",
          textDecorationColor: "currentColor",
          textDecorationThickness: 1,
          textUnderlineOffset: 2,
        }
        : isChild ? { background: "rgba(255,255,255,0.015)", color: PAL.textDim }
        : undefined
      }
    >
      <td style={{ ...S.td, color: PAL.textDim, ...colHide("category") }}>{r.group_name ?? "–"}</td>
      <td style={{ ...S.td, color: PAL.textDim, ...colHide("subCat") }}>{r.sub_category_name ?? "–"}</td>
      <td style={{ ...S.td, fontFamily: "monospace", color: PAL.accent, paddingLeft: (isChild || r.is_user_added) ? 28 : undefined, ...colHide("style") }} onClick={(e) => { if (r.is_tbd) e.stopPropagation(); }}>
        {r.is_aggregate && (
          <span
            onClick={(e) => { e.stopPropagation(); toggleAggExpanded(aggExpansionKey); }}
            style={{ cursor: "pointer", display: "inline-block", width: 14, color: PAL.textMuted, userSelect: "none", transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}
            title={isExpanded ? "Collapse" : "Drill into this row"}
          >▶</span>
        )}
        {!r.is_aggregate && r.is_tbd && r.is_user_added && onUpdateTbdStyle && masterStyles ? (() => {
          // Editable style picker only on planner-added rows. Auto-
          // synthesized per-style and per-period catch-all rows show
          // the style as plain text — they're standing infrastructure,
          // not free-form entries.
          const ctx = buildStyleCellContext(r, rows, masterStyles);
          return (
            <TbdStyleCell
              value={ctx.styleVal}
              isNewStyle={ctx.isNewStyle}
              categoryStyles={ctx.categoryStyles}
              allKnownStylesLower={ctx.allStylesLower}
              masterStylesLower={ctx.masterStylesLower}
              onSave={(styleCode) => onUpdateTbdStyle(r, styleCode)}
            />
          );
        })() : (
          r.sku_style ?? r.sku_code
        )}
        {ppkUnresolved && !r.is_aggregate && (
          <span
            style={{ marginLeft: 6, color: PAL.yellow, cursor: "help", fontSize: 12 }}
            title="Prepack style with no pack size — its Prepack Matrix isn't set up in Tangerine and the SKU carries no PPKn count. Quantities can't convert to packs when Explode PPK is off. Set up the Prepack Matrix in Tangerine, or encode the count in the SKU (e.g. PPK24)."
          >⚠</span>
        )}
      </td>
      <td
        style={{ ...S.td, color: PAL.textDim, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: !r.is_aggregate && r.is_tbd && r.is_user_added ? "0 4px" : undefined, ...colHide("description") }}
        title={r.sku_description ?? ""}
        onClick={(e) => { if (r.is_tbd) e.stopPropagation(); }}
      >
        {!r.is_aggregate && r.is_tbd && r.is_user_added && onUpdateTbdDescription ? (
          <TbdDescriptionCell
            value={r.sku_description ?? ""}
            isNew={!!r.is_new_description}
            knownDescriptions={knownDescriptions}
            masterDescriptionsLower={masterDescriptionsLower}
            onSave={(d) => onUpdateTbdDescription(r, d)}
          />
        ) : (
          r.sku_description ?? "—"
        )}
      </td>
      <td style={{ ...S.td, color: PAL.textDim, padding: r.is_tbd ? "0 4px" : undefined, ...colHide("color") }} onClick={(e) => { if (r.is_tbd) e.stopPropagation(); }}>
        {!r.is_aggregate && r.is_tbd && onUpdateTbdColor ? (() => {
          const ctx = buildColorCellContext(
            r, rows, masterStyles ?? [],
            allKnownColorsLower, masterColorsLower, masterColorsByStyleLower,
          );
          return (
            <TbdColorCell
              value={r.sku_color ?? "TBD"}
              isNewColor={!!r.is_new_color}
              isNewForStyle={ctx.isNewForStyle}
              knownColors={Array.from(colorsByGroupName.get(r.group_name ?? "—") ?? new Set<string>()).sort()}
              allKnownColorsLower={allKnownColorsLower}
              masterColorsLower={masterColorsLower}
              onSave={(color, isNew) => onUpdateTbdColor(r, color, isNew)}
              blocked={ctx.blockColorEdit}
              onBlocked={() => setColorEditBlocked(true)}
            />
          );
        })() : (
          <>
            {r.sku_color ?? "—"}
            {r.sku_color_inferred && (
              <span
                style={{ marginLeft: 6, color: PAL.yellow, cursor: "help", fontSize: 11 }}
                title="Color inferred from sku_code suffix — variant master row has no color set. Populate items.color upstream to silence this hint."
              >•</span>
            )}
          </>
        )}
      </td>
      <td style={{ ...S.td, color: PAL.textDim, textAlign: "center", ...colHide("inseam") }} onClick={(e) => { if (r.is_tbd) e.stopPropagation(); }}>
        {r.sku_inseam ?? "—"}
      </td>
      <td style={{ ...S.td, padding: r.is_tbd ? "0 4px" : undefined, ...colHide("customer") }} onClick={(e) => { if (r.is_tbd) e.stopPropagation(); }}>
        {!r.is_aggregate && r.is_tbd && onUpdateTbdCustomer ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <TbdCustomerCell
              value={r.customer_name}
              isSupplyOnly={r.customer_name === "(Supply Only)"}
              isNewCustomer={!!(r.customer_id && newCustomerIds?.has(r.customer_id))}
              customers={customers}
              newCustomerIds={newCustomerIds}
              onSave={(id, name) => onUpdateTbdCustomer(r, id, name)}
              onAddNew={onAddTbdNewCustomer ? (name) => onAddTbdNewCustomer(r, name) : undefined}
            />
            {r.is_user_added && onPromoteTbdRow
              && r.sku_style && r.sku_style.toUpperCase() !== "TBD"
              && r.sku_color && r.sku_color.toUpperCase() !== "TBD"
              && (() => {
                // Case-insensitive key so "Red"/"red" across rows still match a
                // single promote.
                const promoted = promotedTbdKeys?.has(`${(r.sku_style ?? "").toLowerCase()}|${(r.sku_color ?? "").toLowerCase()}`);
                // The color is already in the company DB when it was promoted
                // this session OR it exists in the master (is_new_color false).
                // In both cases the "Add to DB" button must NOT appear on any
                // period / customer for this style+color. Only a genuinely-new,
                // not-yet-promoted color shows the button; a just-promoted one
                // shows a ✓ (session feedback); an always-in-master color shows
                // nothing.
                if (!promoted && !r.is_new_color) return null;
                return promoted ? (
                  <span
                    title="Added to the company database (Tangerine + ATS)"
                    style={{ color: PAL.green, fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}
                  >✓ in DB</span>
                ) : (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); void onPromoteTbdRow(r); }}
                    title={`Add "${r.sku_style} / ${r.sku_color}" to the company database (Style Master + item master) so it shows in Tangerine + ATS. Someone will be notified to complete the details.`}
                    style={{
                      background: "transparent",
                      border: `1px solid ${PAL.accent}`,
                      color: PAL.accent,
                      borderRadius: 6,
                      padding: "1px 6px",
                      fontSize: 11,
                      cursor: "pointer",
                      fontFamily: "inherit",
                      lineHeight: 1.2,
                      whiteSpace: "nowrap",
                    }}
                  >Add to DB</button>
                );
              })()}
            {r.is_user_added && onDeleteTbdRow && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); void onDeleteTbdRow(r); }}
                title="Delete this planner-added row"
                style={{
                  background: "transparent",
                  border: `1px solid ${PAL.red}`,
                  color: PAL.red,
                  borderRadius: 6,
                  padding: "1px 6px",
                  fontSize: 11,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  lineHeight: 1.2,
                }}
              >
                ✕
              </button>
            )}
          </span>
        ) : (
          r.customer_name
        )}
      </td>
      <td style={{ ...S.td, ...colHide("period") }}>{formatPeriodCode(r.period_code)}</td>
      <td style={{ ...S.td, color: PAL.textDim, fontFamily: "monospace", fontSize: 11, ...colHide("class") }}
          title={r.abc_class && r.xyz_class
            ? `ABC ${r.abc_class} (volume rank) × XYZ ${r.xyz_class} (demand variability)`
            : "Not classified — no trailing sales"}
      >
        {r.abc_class && r.xyz_class ? `${r.abc_class}${r.xyz_class}` : "—"}
      </td>
      <td
        style={{ ...S.tdNum, ...colHide("histT3") }}
        title={((): string => {
          const breakdown = r.historical_trailing_breakdown;
          if (!breakdown || breakdown.length === 0) {
            return "No sales in the trailing 3-month window for this customer + SKU";
          }
          const lines = breakdown.map((b) => `${formatPeriodCode(b.month)}: ${formatQty(b.qty)}`);
          return `Trailing 3 months\n${lines.join("\n")}`;
        })()}
      >{formatQty(r.historical_trailing_qty)}</td>
      <td style={{ ...S.tdNum, color: r.forecast_method === "ly_sales" && r.ly_reference_qty != null ? PAL.accent2 : PAL.textMuted, ...colHide("histLY") }}>
        {r.ly_reference_qty != null ? formatQty(r.ly_reference_qty) : "—"}
      </td>
      <td
        style={{
          ...S.tdNum,
          color: r.historical_margin_pct == null
            ? PAL.textMuted
            : r.historical_margin_pct < 0
              ? PAL.red
              : r.historical_margin_pct >= 0.3
                ? PAL.green
                : PAL.text,
          ...colHide("margin"),
        }}
        title={r.historical_margin_pct == null
          ? "No margin data in the trailing 3-month window for this customer + SKU"
          : `Weighted-avg gross margin over the trailing 3 months (weighted by net sales $)`}
      >
        {r.historical_margin_pct != null ? `${(r.historical_margin_pct * 100).toFixed(1)}%` : "—"}
      </td>
      <td style={{ ...S.tdNum, padding: "0 4px", ...colHide("system") }} onClick={(e) => e.stopPropagation()}>
        {r.is_aggregate ? (
          <span style={{ fontFamily: "monospace", color: PAL.text }}>
            {formatQty(r.system_forecast_qty)}
          </span>
        ) : (
          <SystemCell
            value={r.system_forecast_qty}
            original={r.system_forecast_qty_original}
            overriddenAt={r.system_forecast_qty_overridden_at}
            overriddenBy={r.system_forecast_qty_overridden_by}
            onSave={(qty) => onUpdateSystemOverride(r.forecast_id, toStoredEaches(qty))}
          />
        )}
      </td>
      <td style={{ ...S.tdNum, padding: "0 4px", ...colHide("buyer") }} onClick={(e) => e.stopPropagation()}>
        <IntCell
          value={r.buyer_request_qty}
          accent={PAL.accent}
          allowNegative={false}
          onSave={(qty) => saveAggBuyerOrOverride(r, toStoredEaches(qty) ?? 0, "buyer_request_qty", onUpdateBuyerRequest, false)}
        />
      </td>
      <td style={{ ...S.tdNum, padding: "0 4px", ...colHide("override") }} onClick={(e) => e.stopPropagation()}>
        <IntCell
          value={r.override_qty}
          accent={PAL.yellow}
          allowNegative={true}
          onSave={(qty) => saveAggBuyerOrOverride(r, toStoredEaches(qty) ?? 0, "override_qty", onUpdateOverride, true)}
        />
      </td>
      <td style={{ ...S.tdNum, color: PAL.green, fontWeight: 700, ...colHide("final") }}>
        {/* Final is the live sum of its preceding editable columns
            (System + Buyer + Override, floored at 0) so it updates the instant
            any of them is edited — never a stale stored value. Aggregate rows
            keep their rolled-up total (sum of each child's own floored Final,
            which can differ from flooring the summed parts). */}
        {formatQty(r.is_aggregate ? r.final_forecast_qty : Math.max(0, r.system_forecast_qty + r.buyer_request_qty + r.override_qty))}
      </td>
      <td style={{ ...S.td, ...colHide("confidence") }}>
        <span style={{ ...S.chip, background: CONFIDENCE_COLOR[r.confidence_level] + "33", color: CONFIDENCE_COLOR[r.confidence_level] }}>
          {r.confidence_level}
        </span>
      </td>
      <td style={{ ...S.td, ...colHide("method") }}>
        <span style={{ ...S.chip, background: (METHOD_COLOR[r.forecast_method] ?? PAL.textMuted) + "22", color: METHOD_COLOR[r.forecast_method] ?? PAL.textMuted }}>
          {METHOD_LABEL[r.forecast_method] ?? r.forecast_method}
        </span>
      </td>
      <td
        data-testid="on-hand-cell"
        style={{ ...S.tdNum, cursor: (r.on_hand_qty ?? 0) !== 0 ? "context-menu" : "default", ...colHide("onHand") }}
        title={(r.on_hand_qty ?? 0) !== 0 ? "Right-click for inventory details" : undefined}
        onContextMenu={(e) => { if ((r.on_hand_qty ?? 0) !== 0) void openSummaryCtx(e, "onHand", r); }}
      >{formatQty(r.on_hand_qty)}</td>
      <td
        style={{ ...S.tdNum, color: r.on_so_qty > 0 ? PAL.yellow : PAL.textMuted, cursor: r.on_so_qty > 0 ? "context-menu" : "default", ...colHide("onSo") }}
        title={r.on_so_qty > 0 ? "Right-click for SO line details" : undefined}
        onContextMenu={(e) => { if (r.on_so_qty > 0) void openSummaryCtx(e, "onOrder", r); }}
      >
        {r.on_so_qty > 0 ? formatQty(r.on_so_qty) : "—"}
      </td>
      <td
        style={{ ...S.tdNum, cursor: (r.receipts_due_qty ?? 0) > 0 ? "context-menu" : "default", ...colHide("receipts") }}
        title={(r.receipts_due_qty ?? 0) > 0 ? "Right-click for PO line details" : undefined}
        onContextMenu={(e) => { if ((r.receipts_due_qty ?? 0) > 0) void openSummaryCtx(e, "onPO", r); }}
      >{formatQty(r.receipts_due_qty)}</td>
      <td style={{ ...S.tdNum, color: PAL.textMuted, ...colHide("histRecv") }}>{r.historical_receipts_qty ? formatQty(r.historical_receipts_qty) : "—"}</td>
      <td style={{ ...S.tdNum, color: PAL.text, ...colHide("ats") }}>{formatQty(r.available_supply_qty)}</td>
      <td style={{ ...S.tdNum, padding: "0 4px", ...colHide("buy") }} onClick={(e) => e.stopPropagation()}>
        <BuyCell
          value={r.planned_buy_qty}
          onSave={(qty) => saveAggBuy(r, toStoredEaches(qty))}
        />
      </td>
      <td style={{ ...S.tdNum, color: r.avg_cost ? PAL.text : PAL.textMuted, fontFamily: "monospace", ...colHide("avgCost") }}>
        {r.avg_cost ? `$${r.avg_cost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "–"}
      </td>
      <td style={{ ...S.tdNum, padding: "0 4px", ...colHide("unitCost") }} onClick={(e) => e.stopPropagation()}>
        {r.is_aggregate ? (
          // Editable on collapsed/aggregate rows too: fans the typed cost
          // out to every child of the bucket (saveAggUnitCost). The grid
          // is normally used collapsed by style/all-colors, so this is the
          // primary entry point for manual unit-cost entry.
          <UnitCostCell
            value={r.unit_cost}
            overridden={false}
            onSave={(cost) => saveAggUnitCost(r, cost)}
          />
        ) : (
          <UnitCostCell
            value={r.unit_cost}
            overridden={r.unit_cost_override != null}
            onSave={(cost) => onUpdateUnitCost(r.forecast_id, cost)}
          />
        )}
      </td>
      {(() => {
        const qty = r.planned_buy_qty;
        const cost = r.unit_cost;
        const hasCost = qty != null && qty > 0 && cost != null && cost > 0;
        return (
          <td style={{ ...S.tdNum, color: hasCost ? PAL.green : PAL.textMuted, fontFamily: "monospace", ...colHide("buyDollars") }}>
            {hasCost ? `$${(qty * cost).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "–"}
          </td>
        );
      })()}
      <td style={{ ...S.tdNum, color: r.projected_shortage_qty > 0 ? PAL.red : PAL.textMuted, ...colHide("shortage") }}>
        {formatQty(r.projected_shortage_qty)}
      </td>
      <td style={{ ...S.tdNum, color: r.projected_excess_qty > 0 ? PAL.yellow : PAL.textMuted, ...colHide("excess") }}>
        {formatQty(r.projected_excess_qty)}
      </td>
      <td style={{ ...S.td, ...colHide("action") }}>
        <span style={{ ...S.chip, background: (ACTION_COLOR[r.recommended_action] ?? PAL.textMuted) + "33", color: ACTION_COLOR[r.recommended_action] ?? PAL.textMuted }}>
          {r.recommended_action}
        </span>
      </td>
    </tr>
  );
}
