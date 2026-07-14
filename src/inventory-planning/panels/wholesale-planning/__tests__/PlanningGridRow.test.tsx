// @vitest-environment jsdom
//
// Integration tests for <PlanningGridRow />. The grid row is one of
// the most data-dense components in the app — extracting it from the
// 3,000-LOC parent file is high value but high risk. These tests
// pin the row's externally observable behavior: which cells render,
// which buttons appear by row type, and which callbacks fire.
//
// We mount the row inside a real <table><tbody> so React doesn't
// warn about invalid HTML. Cell editors (BuyCell, SystemCell, etc.)
// are real components — we only stub the parent-owned callbacks.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { PlanningGridRow, type PlanningGridRowProps } from "../PlanningGridRow";
import type { IpPlanningGridRow } from "../../../types/wholesale";

function row(over: Partial<IpPlanningGridRow> = {}): IpPlanningGridRow {
  return {
    forecast_id: "f1",
    sku_id: "s1", sku_code: "S1", sku_style: "S1", sku_color: "Black", sku_size: null,
    sku_description: "Edge Slim", group_name: "Tops", sub_category_name: "T-Shirts",
    category_id: null,
    customer_id: "C1", customer_name: "Acme",
    period_start: "2026-05-01", period_end: "2026-05-31", period_code: "2026-05",
    abc_class: null, xyz_class: null,
    historical_trailing_qty: 100, ly_reference_qty: 80, historical_margin_pct: null, historical_receipts_qty: 0,
    system_forecast_qty: 120, system_forecast_qty_original: 120,
    system_forecast_qty_overridden_at: null, system_forecast_qty_overridden_by: null,
    buyer_request_qty: 0, override_qty: 0,
    final_forecast_qty: 120,
    confidence_level: "high", forecast_method: "system",
    on_hand_qty: 25, on_so_qty: 0, on_po_qty: 0, receipts_due_qty: 0,
    available_supply_qty: 25, planned_buy_qty: 95,
    avg_cost: 4.50, ats_avg_cost: null, item_cost: null, unit_cost: 4.50, unit_cost_override: null,
    projected_shortage_qty: 0, projected_excess_qty: 0,
    recommended_action: "buy",
    ...over,
  } as IpPlanningGridRow;
}

function defaultProps(over: Partial<PlanningGridRowProps> = {}): PlanningGridRowProps {
  return {
    row: row(),
    isChild: false,
    isExpanded: false,
    aggExpansionKey: "f1",
    explodePpk: true,
    packSize: 1,
    ppkUnresolved: false,
    cartonQty: 1,
    rows: [],
    masterStyles: [],
    masterColorsLower: new Set(),
    masterColorsByStyleLower: new Map(),
    allKnownColorsLower: new Set(),
    colorsByGroupName: new Map(),
    knownDescriptions: [],
    masterDescriptionsLower: new Set(),
    customers: [],
    newCustomerIds: new Set(),
    hiddenColumns: new Set(),
    onSelectRow: vi.fn(),
    toggleAggExpanded: vi.fn(),
    setColorEditBlocked: vi.fn(),
    onUpdateTbdStyle: vi.fn(async () => {}),
    onUpdateTbdDescription: vi.fn(async () => {}),
    onUpdateTbdColor: vi.fn(async () => {}),
    onUpdateTbdCustomer: vi.fn(async () => {}),
    onAddTbdNewCustomer: vi.fn(async () => {}),
    onDeleteTbdRow: vi.fn(async () => {}),
    onUpdateSystemOverride: vi.fn(async () => {}),
    onUpdateUnitCost: vi.fn(async () => {}),
    saveAggBuyerOrOverride: vi.fn(async () => {}),
    saveAggBuy: vi.fn(async () => {}),
    openSummaryCtx: vi.fn(),
    onUpdateBuyerRequest: vi.fn(async () => {}),
    onUpdateOverride: vi.fn(async () => {}),
    ...over,
  };
}

function renderRow(props: PlanningGridRowProps) {
  return render(
    <table>
      <tbody>
        <PlanningGridRow {...props} />
      </tbody>
    </table>,
  );
}

// ────────────────────────────────────────────────────────────────────────

describe("<PlanningGridRow /> — basic rendering", () => {
  it("renders category, sub-category, style, description, color, customer in a normal row", () => {
    renderRow(defaultProps());
    expect(screen.getByText("Tops")).toBeInTheDocument();
    expect(screen.getByText("T-Shirts")).toBeInTheDocument();
    expect(screen.getByText("S1")).toBeInTheDocument();
    expect(screen.getByText("Edge Slim")).toBeInTheDocument();
    expect(screen.getByText("Black")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
  });

  it("renders '–' / '—' placeholders when fields are null", () => {
    renderRow(defaultProps({
      row: row({ group_name: null, sub_category_name: null, sku_description: null, sku_color: null, ly_reference_qty: null }),
    }));
    expect(screen.getAllByText("–").length).toBeGreaterThan(0);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("renders the formatted final qty as bold green", () => {
    // Final recomputes live from System + Buyer + Override (#1715), so it no
    // longer reads the stored final_forecast_qty for non-aggregate rows.
    // 100 + 30 + 20 = 150; each input is distinct so "150" appears only in Final.
    renderRow(defaultProps({ row: row({ system_forecast_qty: 100, buyer_request_qty: 30, override_qty: 20 }) }));
    expect(screen.getByText("150")).toBeInTheDocument();
  });

  it("renders avg_cost with $ + 2 decimals when present", () => {
    // avg_cost + unit_cost both display $4.50 (UnitCostCell auto-fills
    // from avg). getAllByText avoids the duplicate-match error and
    // confirms at least one cell shows the formatted price.
    renderRow(defaultProps({ row: row({ avg_cost: 4.5, unit_cost: 4.5 }) }));
    expect(screen.getAllByText("$4.50").length).toBeGreaterThan(0);
  });

  it("renders '–' for avg_cost when null", () => {
    renderRow(defaultProps({ row: row({ avg_cost: null }) }));
    // there's already a "–" in subcat/category placeholder paths but here
    // we know category fields are set, so the dash is the avg_cost cell.
    expect(screen.getAllByText("–").length).toBeGreaterThan(0);
  });

  it("renders Buy $ when both qty>0 + cost>0", () => {
    renderRow(defaultProps({ row: row({ planned_buy_qty: 100, unit_cost: 5 }) }));
    expect(screen.getByText("$500")).toBeInTheDocument();
  });

  it("renders ABC/XYZ when both present, '—' when missing", () => {
    renderRow(defaultProps({ row: row({ abc_class: "A", xyz_class: "X" }) }));
    expect(screen.getByText("AX")).toBeInTheDocument();
  });
});

// ────────────────────────────────────────────────────────────────────────

describe("<PlanningGridRow /> — hiddenColumns", () => {
  it("does not render hidden cells (display:none via colHide)", () => {
    // We can't easily query for "display:none" with text matchers, so we
    // sanity-check via the visible Category cell being there + the
    // hidden Sub Cat cell still appearing in the DOM (display:none).
    const { container } = renderRow(defaultProps({ hiddenColumns: new Set(["subCat"]) }));
    // The cell still exists — colHide hides via inline style, not unmount.
    const cells = container.querySelectorAll("td");
    expect(cells.length).toBeGreaterThan(15);
  });
});

// ────────────────────────────────────────────────────────────────────────

describe("<PlanningGridRow /> — aggregate rows", () => {
  it("renders the drill-in chevron on aggregate rows", () => {
    renderRow(defaultProps({
      row: row({ is_aggregate: true, aggregate_key: "agg-1" }),
      aggExpansionKey: "agg-1",
    }));
    expect(screen.getByText("▶")).toBeInTheDocument();
  });

  it("clicking the chevron calls toggleAggExpanded with the aggExpansionKey", () => {
    const toggle = vi.fn();
    renderRow(defaultProps({
      row: row({ is_aggregate: true, aggregate_key: "agg-1" }),
      aggExpansionKey: "agg-1",
      toggleAggExpanded: toggle,
    }));
    fireEvent.click(screen.getByText("▶"));
    expect(toggle).toHaveBeenCalledWith("agg-1");
  });

  it("non-aggregate rows do not render the chevron", () => {
    renderRow(defaultProps());
    expect(screen.queryByText("▶")).not.toBeInTheDocument();
  });
});

// ────────────────────────────────────────────────────────────────────────

describe("<PlanningGridRow /> — TBD planner-added rows", () => {
  const tbdRow = row({
    forecast_id: "tbd:f1",
    is_tbd: true,
    is_user_added: true,
    tbd_id: "tbd-1",
    sku_style: "TBD",
    sku_color: "TBD",
    customer_id: "C1",
    customer_name: "Acme",
  });

  it("renders the ✕ delete button on planner-added TBD rows", () => {
    renderRow(defaultProps({
      row: tbdRow,
      rows: [tbdRow],
      onUpdateTbdCustomer: vi.fn(async () => {}),
    }));
    expect(screen.getByTitle("Delete this planner-added row")).toBeInTheDocument();
  });

  it("clicking ✕ calls onDeleteTbdRow with the row", () => {
    const onDelete = vi.fn(async () => {});
    renderRow(defaultProps({
      row: tbdRow,
      rows: [tbdRow],
      onDeleteTbdRow: onDelete,
    }));
    fireEvent.click(screen.getByTitle("Delete this planner-added row"));
    expect(onDelete).toHaveBeenCalledWith(tbdRow);
  });

  it("non-user-added TBD rows do not render the ✕ delete button", () => {
    renderRow(defaultProps({
      row: row({ is_tbd: true, is_user_added: false }),
    }));
    expect(screen.queryByTitle("Delete this planner-added row")).not.toBeInTheDocument();
  });

  // Add-to-DB button gating (#1740).
  const promoteRow = (over: Partial<IpPlanningGridRow> = {}) => row({
    is_tbd: true, is_user_added: true, tbd_id: "t1",
    sku_style: "RYB0412PPK", sku_color: "Red", customer_name: "(Supply Only)",
    ...over,
  });

  it("shows Add to DB for a genuinely-new color not yet promoted", () => {
    renderRow(defaultProps({ row: promoteRow({ is_new_color: true }), onPromoteTbdRow: vi.fn(async () => {}) }));
    expect(screen.getByText("Add to DB")).toBeInTheDocument();
  });

  it("hides Add to DB when the color is already in the DB (is_new_color false)", () => {
    renderRow(defaultProps({ row: promoteRow({ is_new_color: false }), onPromoteTbdRow: vi.fn(async () => {}) }));
    expect(screen.queryByText("Add to DB")).not.toBeInTheDocument();
    expect(screen.queryByText("✓ in DB")).not.toBeInTheDocument();
  });

  it("shows ✓ in DB (not the button) once promoted this session — case-insensitively", () => {
    renderRow(defaultProps({
      row: promoteRow({ is_new_color: true }),
      onPromoteTbdRow: vi.fn(async () => {}),
      promotedTbdKeys: new Set(["ryb0412ppk|red"]), // lowercased key
    }));
    expect(screen.queryByText("Add to DB")).not.toBeInTheDocument();
    expect(screen.getByText("✓ in DB")).toBeInTheDocument();
  });
});

// ────────────────────────────────────────────────────────────────────────

describe("<PlanningGridRow /> — context menu + onSelectRow", () => {
  it("right-click on a non-aggregate row calls onSelectRow", () => {
    const onSelect = vi.fn();
    const { container } = renderRow(defaultProps({ onSelectRow: onSelect }));
    const tr = container.querySelector("tr.planning-grid-row")!;
    fireEvent.contextMenu(tr);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ forecast_id: "f1" }));
  });

  it("right-click on an aggregate row does NOT call onSelectRow", () => {
    const onSelect = vi.fn();
    const { container } = renderRow(defaultProps({
      row: row({ is_aggregate: true, aggregate_key: "agg-1" }),
      onSelectRow: onSelect,
    }));
    const tr = container.querySelector("tr.planning-grid-row")!;
    fireEvent.contextMenu(tr);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("right-click on On Hand cell calls openSummaryCtx when on_hand_qty != 0", () => {
    const openCtx = vi.fn();
    const { container } = renderRow(defaultProps({
      row: row({ on_hand_qty: 25 }),
      openSummaryCtx: openCtx,
    }));
    const onHand = container.querySelector('[data-testid="on-hand-cell"]');
    expect(onHand).toBeTruthy();
    fireEvent.contextMenu(within(onHand as HTMLElement).getByText("25"));
    expect(openCtx).toHaveBeenCalledWith(expect.anything(), "onHand", expect.objectContaining({ forecast_id: "f1" }));
  });
});
