// @vitest-environment jsdom
// Sales Comps Style picker — regression tests for the #1897 master-
// sourced option list and the follow-up perf hardening:
//   * sold-out styles (master-only, no grid row) are searchable and
//     selectable, and a click toggles exactly once and sticks
//   * the popover renders a capped number of rows (large lists froze
//     the picker — operator report 2026-07-22) with a "keep typing"
//     footer for the remainder
//   * selected options stay pinned/visible even when they'd fall
//     outside the cap
import React from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { SalesCompsModal } from "../panels/SalesCompsModal";
import { __setCacheForTest, clearItemMasterCache, getAllMasterStyles } from "../itemMasterLookup";
import type { ItemMasterRecord } from "../itemMasterLookup";

function rec(over: Partial<ItemMasterRecord>): ItemMasterRecord {
  return {
    id: over.id ?? "id-" + over.sku_code,
    sku_code: over.sku_code ?? "X",
    style_code: over.style_code ?? null,
    color: over.color ?? null,
    size: over.size ?? null,
    description: over.description ?? null,
    attributes: over.attributes ?? {},
    ...over,
  } as ItemMasterRecord;
}

function renderModal(): void {
  render(
    <SalesCompsModal
      onClose={() => {}}
      defaultCustomer=""
      defaultCategories={[]}
      defaultSubCategories={[]}
      defaultStyles={[]}
      defaultStoreFilter={[]}
      defaultGenders={[]}
      allCategories={[]}
      allSubCategories={[]}
      allStyles={["GRIDONLY1"]}
      allStores={[]}
      rows={[]}
      excelData={{ syncedAt: "", skus: [], pos: [], sos: [], warnings: [], columnNames: [] } as any}
      explodePpk={false}
    />,
  );
}

function styleField(): HTMLElement {
  return screen.getByText("Style").parentElement as HTMLElement;
}

describe("Sales Comps style picker with full master list", () => {
  beforeEach(() => {
    clearItemMasterCache();
    // ~3000 styles like the prod master. ZZZ1893 sorts LAST so it is
    // guaranteed to sit beyond the visible-row cap when unfiltered.
    const records: ItemMasterRecord[] = [];
    for (let i = 0; i < 3000; i++) {
      const code = `RYB${String(i).padStart(4, "0")}`;
      records.push(rec({ id: `s${i}`, sku_code: code, style_code: code, description: `Style ${i}` }));
    }
    records.push(rec({ id: "tgt", sku_code: "ZZZ1893", style_code: "ZZZ1893", description: "La Virgen" }));
    __setCacheForTest(records);
  });

  it("caps rendered rows and shows a keep-typing footer for the rest", () => {
    expect(getAllMasterStyles().length).toBe(3001);
    renderModal();
    const field = styleField();
    fireEvent.click(within(field).getByRole("button"));

    const boxes = within(field).getAllByRole("checkbox");
    expect(boxes.length).toBeLessThanOrEqual(250);
    expect(within(field).getByText(/more — keep typing to narrow/)).toBeTruthy();
  });

  it("master-only (sold-out) style is searchable, click toggles once and sticks", () => {
    renderModal();
    const field = styleField();
    fireEvent.click(within(field).getByRole("button"));

    const search = within(field).getByPlaceholderText("Search…");
    fireEvent.change(search, { target: { value: "ZZZ1893" } });

    const option = within(field).getByText(/ZZZ1893 — La Virgen/);
    fireEvent.click(option);
    const checkbox = within(field).getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    // Second click unchecks — exactly one toggle per click.
    fireEvent.click(option);
    expect(checkbox.checked).toBe(false);
  });

  it("selected options stay pinned/visible beyond the cap; summary reflects them", () => {
    renderModal();
    const field = styleField();
    fireEvent.click(within(field).getByRole("button"));

    const search = within(field).getByPlaceholderText("Search…");
    fireEvent.change(search, { target: { value: "ZZZ1893" } });
    fireEvent.click(within(field).getByText(/ZZZ1893 — La Virgen/));

    // Clear the search: ZZZ1893 sorts dead last (beyond the cap), but as
    // a SELECTED option it must stay pinned at the top, still checked.
    fireEvent.change(search, { target: { value: "" } });
    const boxes = within(field).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.length).toBeLessThanOrEqual(250);
    expect(boxes[0].checked).toBe(true);
    expect(boxes[0].closest("label")?.textContent).toContain("ZZZ1893");

    expect((within(field).getByRole("button") as HTMLButtonElement).textContent).toContain("ZZZ1893");
  });
});
