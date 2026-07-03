// @vitest-environment jsdom
// Integration tests for MatrixGrid. Render the whole component, exercise pivot
// controls + filter chips + cell click + layered tabs.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MatrixGrid } from "../MatrixGrid";
import type { MatrixItem } from "../types";

function item(over: Partial<MatrixItem>): MatrixItem {
  return {
    id: over.id ?? "x",
    color: over.color ?? null,
    size: over.size ?? null,
    inseam: over.inseam ?? null,
    length: over.length ?? null,
    fit: over.fit ?? null,
    rise: over.rise ?? null,
    value: over.value,
  };
}

const items: MatrixItem[] = [
  item({ id: "1", color: "RED",  size: "M", inseam: "30", length: "REGULAR", fit: "SLIM" }),
  item({ id: "2", color: "RED",  size: "L", inseam: "30", length: "REGULAR", fit: "SLIM" }),
  item({ id: "3", color: "BLUE", size: "M", inseam: "32", length: "LONG",    fit: "RELAXED" }),
  item({ id: "4", color: "BLUE", size: "L", inseam: "32", length: "LONG",    fit: "RELAXED" }),
];

describe("MatrixGrid", () => {
  it("renders a 2-D color × size grid by default", () => {
    render(<MatrixGrid items={items} />);
    expect(screen.getByTestId("matrix-table")).toBeInTheDocument();
    expect(screen.getByTestId("matrix-col-header-M")).toBeInTheDocument();
    expect(screen.getByTestId("matrix-col-header-L")).toBeInTheDocument();
    expect(screen.getByTestId("matrix-row-header-RED")).toBeInTheDocument();
    expect(screen.getByTestId("matrix-row-header-BLUE")).toBeInTheDocument();
  });

  it("renders empty cell as a dash", () => {
    // Provide axisValues that introduce GREEN — empty everywhere
    render(
      <MatrixGrid
        items={items}
        axisValues={{ color: ["RED", "BLUE", "GREEN"] }}
      />,
    );
    const greenM = screen.getByTestId("matrix-cell-GREEN-M");
    expect(greenM.textContent).toBe("–");
  });

  it("count formatter renders item counts per cell", () => {
    render(<MatrixGrid items={items} />);
    expect(screen.getByTestId("matrix-cell-RED-M").textContent).toBe("1");
    expect(screen.getByTestId("matrix-cell-BLUE-L").textContent).toBe("1");
  });

  it("custom formatter wins", () => {
    render(<MatrixGrid items={items} format={(items) => (items.length ? "•" : "")} />);
    expect(screen.getByTestId("matrix-cell-RED-M").textContent).toBe("•");
  });

  it("pivoting axes via the row select swaps the layout", () => {
    render(<MatrixGrid items={items} />);
    // Row axis is the first themed SearchableSelect (combobox); open + pick.
    const rowCombo = screen.getAllByRole("combobox")[0];
    fireEvent.focus(rowCombo.querySelector("input")!);
    fireEvent.mouseDown(within(screen.getByRole("listbox")).getByRole("option", { name: "inseam" }));
    expect(screen.getByTestId("matrix-row-header-30")).toBeInTheDocument();
    expect(screen.getByTestId("matrix-row-header-32")).toBeInTheDocument();
  });

  it("filter chip toggles a single-value filter on a non-axis dim", () => {
    render(<MatrixGrid items={items} />);
    // inseam is non-axis by default. Toggle the "30" chip → only RED items should remain.
    const chip30 = screen.getByTestId("matrix-filter-inseam-30");
    fireEvent.click(chip30);
    // After filter, RED row exists, BLUE has no inseam=30 items → its cells are empty (dashes).
    const blueM = screen.getByTestId("matrix-cell-BLUE-M");
    expect(blueM.textContent).toBe("–");
    const redM = screen.getByTestId("matrix-cell-RED-M");
    expect(redM.textContent).toBe("1");
  });

  it("multi-value filter on non-axis dim renders layered tabs", () => {
    render(<MatrixGrid items={items} />);
    const chip30 = screen.getByTestId("matrix-filter-inseam-30");
    const chip32 = screen.getByTestId("matrix-filter-inseam-32");
    fireEvent.click(chip30);
    fireEvent.click(chip32);
    expect(screen.getByTestId("matrix-layered")).toBeInTheDocument();
    expect(screen.getByTestId("matrix-layer-tab-0")).toBeInTheDocument();
    expect(screen.getByTestId("matrix-layer-tab-1")).toBeInTheDocument();
  });

  it("read-only is the default — cells render without role=button", () => {
    render(<MatrixGrid items={items} />);
    const cell = screen.getByTestId("matrix-cell-RED-M");
    expect(cell.getAttribute("role")).toBeNull();
  });

  it("editable cells fire onCellClick", () => {
    const onCellClick = vi.fn();
    render(<MatrixGrid items={items} readOnly={false} onCellClick={onCellClick} />);
    const cell = screen.getByTestId("matrix-cell-RED-M");
    fireEvent.click(cell);
    expect(onCellClick).toHaveBeenCalledTimes(1);
    expect(onCellClick.mock.calls[0][0].rowKey).toBe("RED");
    expect(onCellClick.mock.calls[0][0].colKey).toBe("M");
  });

  it("empty cells don't fire onCellClick even in editable mode", () => {
    const onCellClick = vi.fn();
    render(
      <MatrixGrid
        items={items}
        axisValues={{ color: ["RED", "BLUE", "GREEN"] }}
        readOnly={false}
        onCellClick={onCellClick}
      />,
    );
    const greenM = screen.getByTestId("matrix-cell-GREEN-M");
    fireEvent.click(greenM);
    expect(onCellClick).not.toHaveBeenCalled();
  });

  it("renders 'No data' when item set is empty", () => {
    render(<MatrixGrid items={[]} />);
    expect(screen.getByTestId("matrix-empty")).toBeInTheDocument();
  });
});
