// @vitest-environment jsdom
// EditableSizeMatrix — collapsible size columns + qty-commit callback + the
// shared "hide empty sizes" (default ON) and "totals only" view prefs.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EditableSizeMatrix, matrixCellKey } from "../EditableSizeMatrix";
import { MATRIX_HIDE_EMPTY_KEY, MATRIX_TOTALS_ONLY_KEY } from "../matrixPrefs";

const rows = [{ key: "RED|", color: "RED" }];
const sizes = ["XS", "S", "M", "L", "XL"];

// The collapse/totals prefs persist in localStorage; isolate every test so one
// test's toggle (which now writes the shared pref) can't leak into the next.
beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });

describe("EditableSizeMatrix collapsibleSizes", () => {
  it("does not collapse when no quantities are entered", () => {
    render(
      <EditableSizeMatrix rows={rows} sizes={sizes} qty={{}} onQtyChange={() => {}} collapsibleSizes />,
    );
    // Color + 5 sizes + Total = 7 column headers; nothing to collapse even though
    // the hide-empty default is ON (there is no filled range to collapse around).
    expect(screen.getAllByRole("columnheader")).toHaveLength(7);
  });

  it("DEFAULTS to hidden empty columns (green collapse ON) and the green header toggles", () => {
    // Quantities only on M and L → XS,S (leading) and XL (trailing) are empty.
    const qty = { [matrixCellKey("RED|", "M")]: 24, [matrixCellKey("RED|", "L")]: 12 };
    render(
      <EditableSizeMatrix rows={rows} sizes={sizes} qty={qty} onQtyChange={() => {}} collapsibleSizes />,
    );
    // Default ON → already collapsed: Color + M + L + Total = 4 headers.
    let headers = screen.getAllByRole("columnheader");
    expect(headers).toHaveLength(4);
    expect(headers[1].textContent).toContain("M"); // leading-hidden marker may prefix "⋯ "
    expect(headers[2].textContent).toContain("L"); // trailing-hidden marker may suffix " ⋯"

    // Click the green first-size header → expand to all five sizes (7 headers).
    fireEvent.click(headers[1]);
    headers = screen.getAllByRole("columnheader");
    expect(headers).toHaveLength(7);
    expect(headers[1].textContent).toBe("XS");

    // Click again → collapse back to the filled range.
    fireEvent.click(headers[1]);
    expect(screen.getAllByRole("columnheader")).toHaveLength(4);
  });

  it("respects an explicit hide-empty=false pref (starts expanded)", () => {
    localStorage.setItem(MATRIX_HIDE_EMPTY_KEY, "false");
    const qty = { [matrixCellKey("RED|", "M")]: 24, [matrixCellKey("RED|", "L")]: 12 };
    render(
      <EditableSizeMatrix rows={rows} sizes={sizes} qty={qty} onQtyChange={() => {}} collapsibleSizes />,
    );
    // Pref off → all five size columns shown up front (7 headers).
    expect(screen.getAllByRole("columnheader")).toHaveLength(7);
  });

  it("TOTALS ONLY hides every size column but keeps the Total + money totals", () => {
    localStorage.setItem(MATRIX_TOTALS_ONLY_KEY, "true");
    const qty = { [matrixCellKey("RED|", "M")]: 24, [matrixCellKey("RED|", "L")]: 12 };
    render(
      <EditableSizeMatrix
        rows={rows} sizes={sizes} qty={qty} onQtyChange={() => {}} collapsibleSizes
        unit={{ label: "Unit $", values: { "RED|": "10" }, onChange: () => {}, onSetAll: () => {}, showLineTotal: true }}
      />,
    );
    // No size columns: Color + Total + Unit $ + Total $ = 4 headers (no XS…XL).
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers.some((t) => t === "XS" || t === "S" || t === "M" || t === "L" || t === "XL")).toBe(false);
    // Row total (24 + 12 = 36) and extended $ (36 × 10 = 360) are unchanged.
    expect(screen.getAllByText("36").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$360.00").length).toBeGreaterThan(0);
  });

  it("fires onCellCommit with committed + focus values on blur", () => {
    const onCellCommit = vi.fn();
    render(
      <EditableSizeMatrix rows={rows} sizes={["M"]} qty={{}} onQtyChange={() => {}} onCellCommit={onCellCommit} />,
    );
    const input = screen.getByLabelText("Qty RED M") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "50" } });
    fireEvent.blur(input);
    expect(onCellCommit).toHaveBeenCalledWith("RED|", "M", 50, 0);
  });

  it("renders the opt-in per-row Lot column and fires onChange/onSetAll", () => {
    const onChange = vi.fn();
    const onSetAll = vi.fn();
    render(
      <EditableSizeMatrix
        rows={rows} sizes={["M"]} qty={{}} onQtyChange={() => {}}
        lot={{ values: { "RED|": "LOT-A" }, onChange, onSetAll }}
      />,
    );
    // Per-row lot input shows the seeded value and pushes edits up.
    const input = screen.getByLabelText("Lot RED") as HTMLInputElement;
    expect(input.value).toBe("LOT-A");
    fireEvent.change(input, { target: { value: "PO-2026-00007" } });
    expect(onChange).toHaveBeenCalledWith("RED|", "PO-2026-00007");

    // The "set all" header input stamps every row on Enter.
    const setAll = screen.getByPlaceholderText("set all") as HTMLInputElement;
    fireEvent.change(setAll, { target: { value: "LOT-Z" } });
    fireEvent.keyDown(setAll, { key: "Enter" });
    expect(onSetAll).toHaveBeenCalledWith("LOT-Z");
  });

  it("omits the Lot column when the lot prop is not given", () => {
    render(<EditableSizeMatrix rows={rows} sizes={["M"]} qty={{}} onQtyChange={() => {}} />);
    expect(screen.queryByLabelText("Lot RED")).toBeNull();
  });
});
