// @vitest-environment jsdom
// EditableSizeMatrix — collapsible size columns + qty-commit callback.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EditableSizeMatrix, matrixCellKey } from "../EditableSizeMatrix";

const rows = [{ key: "RED|", color: "RED" }];
const sizes = ["XS", "S", "M", "L", "XL"];

describe("EditableSizeMatrix collapsibleSizes", () => {
  it("does not collapse when no quantities are entered", () => {
    render(
      <EditableSizeMatrix rows={rows} sizes={sizes} qty={{}} onQtyChange={() => {}} collapsibleSizes />,
    );
    // Color + 5 sizes + Total = 7 column headers; nothing to collapse.
    expect(screen.getAllByRole("columnheader")).toHaveLength(7);
  });

  it("green first-size header collapses leading/trailing zero columns and toggles back", () => {
    // Quantities only on M and L → XS,S (leading) and XL (trailing) are empty.
    const qty = { [matrixCellKey("RED|", "M")]: 24, [matrixCellKey("RED|", "L")]: 12 };
    render(
      <EditableSizeMatrix rows={rows} sizes={sizes} qty={qty} onQtyChange={() => {}} collapsibleSizes />,
    );
    let headers = screen.getAllByRole("columnheader");
    expect(headers).toHaveLength(7); // Color + XS S M L XL + Total

    // First size header is XS (index 1, after Color) and is clickable.
    const firstSize = headers[1];
    expect(firstSize.textContent).toBe("XS");
    fireEvent.click(firstSize);

    // Collapsed: only M and L remain → Color + M + L + Total = 4 headers.
    headers = screen.getAllByRole("columnheader");
    expect(headers).toHaveLength(4);
    const sizeText = headers.slice(1, 3).map((h) => h.textContent);
    expect(sizeText[0]).toContain("M"); // leading-hidden marker may prefix "⋯ "
    expect(sizeText[1]).toContain("L"); // trailing-hidden marker may suffix " ⋯"

    // Click again to expand back to all five sizes.
    fireEvent.click(headers[1]);
    expect(screen.getAllByRole("columnheader")).toHaveLength(7);
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
