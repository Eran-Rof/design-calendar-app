// @vitest-environment jsdom
//
// Tests for <UnitCostCell />. The display state must be a full-cell click
// target: a click ANYWHERE in the cell (not just precisely on the "$5.00" /
// "—" glyph) enters edit mode. jsdom has no layout, so we can't simulate a
// geometric click on empty cell space — instead we prove the equivalent:
//   1) the display target FILLS the cell (flex, width:100%, full min-height),
//      so any pixel inside the cell rectangle lands on it, and
//   2) activating that full-cell target enters edit mode.
// We mount inside a real <table><tbody><tr><td> that mirrors the grid cell
// (padded box + stopPropagation) so the fill has a real box to occupy.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { UnitCostCell } from "../UnitCostCell";

function renderCell(value: number | null, overridden = false) {
  const onSave = vi.fn(async () => {});
  const utils = render(
    <table>
      <tbody>
        <tr>
          {/* Mirror the grid <td>: padded numeric cell that stops row-select. */}
          <td
            data-testid="cell"
            style={{ padding: "0 4px", textAlign: "right" }}
            onClick={(e) => e.stopPropagation()}
          >
            <UnitCostCell value={value} overridden={overridden} onSave={onSave} />
          </td>
        </tr>
      </tbody>
    </table>
  );
  return { onSave, ...utils };
}

describe("<UnitCostCell /> — click anywhere enters edit mode", () => {
  it("valued cell: the display target fills the whole cell and clicking it opens the input", () => {
    renderCell(5);
    // Display state: plain value, no input yet.
    expect(screen.getByText("$5.00")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    // The clickable target fills the entire cell (not just the text width),
    // so a click on any part of the cell area lands here.
    const target = screen.getByRole("button");
    expect(target).toHaveStyle({ display: "flex", width: "100%", minHeight: "24px" });

    fireEvent.click(target);

    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("data-unitcost", "1");
    expect(input.value).toBe("5.00");
  });

  it('null/"—" cell: the empty cell is a full-height target and clicking it opens the input', () => {
    renderCell(null);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    // Even an empty "—" cell fills the full cell height (minHeight), so
    // clicking empty space in the cell — not just the tiny dash — works.
    const target = screen.getByRole("button");
    expect(target).toHaveStyle({ display: "flex", width: "100%", minHeight: "24px" });

    fireEvent.click(target);

    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.value).toBe("");
  });

  it("right-aligns to match the numeric columns (justify-content flex-end)", () => {
    renderCell(5);
    expect(screen.getByRole("button")).toHaveStyle({ justifyContent: "flex-end" });
  });

  it("keyboard a11y preserved: Enter on the full-cell target opens the input", () => {
    renderCell(7.25);
    fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" });
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });
});
