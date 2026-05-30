// @vitest-environment jsdom
//
// Tests for the universal row-click-to-edit primitive
// (operator ask #4 — see src/tanda/hooks/useRowClickEdit.ts).
//
// Coverage:
//   • plain left-click triggers onRowClick
//   • Ctrl/Cmd/Shift/Alt + left-click do NOT trigger
//   • non-primary mouse buttons (middle / right) do NOT trigger
//   • clicks on a child button/link/input/select/textarea do NOT bubble
//   • clicks on elements with role=button or data-row-click-skip skip too
//   • Enter and Space keys trigger when row itself has focus
//   • Enter/Space on a child interactive element do NOT trigger
//   • disabled rows are inert (no role, no tabIndex, no click handler fires)
//   • lastClickedRowId() reports the most recently-clicked id

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useRowClickEdit, __internal } from "../useRowClickEdit";

type Row = { id: string; label: string };

function Harness({
  rows,
  onRowClick,
  disabled,
  ariaLabel,
}: {
  rows: Row[];
  onRowClick: (r: Row) => void;
  disabled?: (r: Row) => boolean;
  ariaLabel?: string | ((r: Row) => string);
}) {
  const { getRowProps, lastClickedRowId } = useRowClickEdit<Row>({
    onRowClick,
    disabled,
    ariaLabel,
  });
  return (
    <table>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} {...getRowProps(r)} data-testid={`row-${r.id}`}>
            <td>{r.label}</td>
            <td>
              <button data-testid={`btn-${r.id}`} onClick={(e) => e.stopPropagation()}>
                edit
              </button>
            </td>
            <td>
              <a href="/foo" data-testid={`a-${r.id}`}>link</a>
            </td>
            <td>
              <input data-testid={`inp-${r.id}`} defaultValue="x" />
            </td>
            <td>
              <span role="button" data-testid={`rb-${r.id}`}>rb</span>
            </td>
            <td>
              <span data-row-click-skip="true" data-testid={`skip-${r.id}`}>nope</span>
            </td>
          </tr>
        ))}
        <tr>
          <td colSpan={6}>
            <span data-testid="last-id">{lastClickedRowId() ?? "(none)"}</span>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

const ROWS: Row[] = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Bravo" },
];

describe("useRowClickEdit — pointer behaviour", () => {
  it("fires onRowClick on a plain left-click on the row", () => {
    const cb = vi.fn();
    render(<Harness rows={ROWS} onRowClick={cb} />);
    fireEvent.click(screen.getByTestId("row-a"));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(ROWS[0]);
  });

  it("does NOT fire on Ctrl+click", () => {
    const cb = vi.fn();
    render(<Harness rows={ROWS} onRowClick={cb} />);
    fireEvent.click(screen.getByTestId("row-a"), { ctrlKey: true });
    expect(cb).not.toHaveBeenCalled();
  });

  it("does NOT fire on Cmd+click (metaKey)", () => {
    const cb = vi.fn();
    render(<Harness rows={ROWS} onRowClick={cb} />);
    fireEvent.click(screen.getByTestId("row-a"), { metaKey: true });
    expect(cb).not.toHaveBeenCalled();
  });

  it("does NOT fire on Shift+click", () => {
    const cb = vi.fn();
    render(<Harness rows={ROWS} onRowClick={cb} />);
    fireEvent.click(screen.getByTestId("row-a"), { shiftKey: true });
    expect(cb).not.toHaveBeenCalled();
  });

  it("does NOT fire on Alt+click", () => {
    const cb = vi.fn();
    render(<Harness rows={ROWS} onRowClick={cb} />);
    fireEvent.click(screen.getByTestId("row-a"), { altKey: true });
    expect(cb).not.toHaveBeenCalled();
  });

  it("does NOT fire on middle-click (button=1)", () => {
    const cb = vi.fn();
    render(<Harness rows={ROWS} onRowClick={cb} />);
    fireEvent.click(screen.getByTestId("row-a"), { button: 1 });
    expect(cb).not.toHaveBeenCalled();
  });

  it("does NOT fire on right-click (button=2)", () => {
    const cb = vi.fn();
    render(<Harness rows={ROWS} onRowClick={cb} />);
    fireEvent.click(screen.getByTestId("row-a"), { button: 2 });
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("useRowClickEdit — child interactive element fall-through", () => {
  it("does NOT fire when click originates on a child <button>", () => {
    const cb = vi.fn();
    render(<Harness rows={ROWS} onRowClick={cb} />);
    fireEvent.click(screen.getByTestId("btn-a"));
    expect(cb).not.toHaveBeenCalled();
  });

  it("does NOT fire when click originates on a child <a href>", () => {
    const cb = vi.fn();
    render(<Harness rows={ROWS} onRowClick={cb} />);
    fireEvent.click(screen.getByTestId("a-a"));
    expect(cb).not.toHaveBeenCalled();
  });

  it("does NOT fire when click originates on a child <input>", () => {
    const cb = vi.fn();
    render(<Harness rows={ROWS} onRowClick={cb} />);
    fireEvent.click(screen.getByTestId("inp-a"));
    expect(cb).not.toHaveBeenCalled();
  });

  it("does NOT fire when click originates on a role=button child", () => {
    const cb = vi.fn();
    render(<Harness rows={ROWS} onRowClick={cb} />);
    fireEvent.click(screen.getByTestId("rb-a"));
    expect(cb).not.toHaveBeenCalled();
  });

  it("does NOT fire when click originates on a data-row-click-skip='true' child", () => {
    const cb = vi.fn();
    render(<Harness rows={ROWS} onRowClick={cb} />);
    fireEvent.click(screen.getByTestId("skip-a"));
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("useRowClickEdit — keyboard activation", () => {
  it("Enter on the row triggers onRowClick", () => {
    const cb = vi.fn();
    render(<Harness rows={ROWS} onRowClick={cb} />);
    fireEvent.keyDown(screen.getByTestId("row-a"), { key: "Enter" });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(ROWS[0]);
  });

  it("Space on the row triggers onRowClick", () => {
    const cb = vi.fn();
    render(<Harness rows={ROWS} onRowClick={cb} />);
    fireEvent.keyDown(screen.getByTestId("row-a"), { key: " " });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("other keys do NOT trigger", () => {
    const cb = vi.fn();
    render(<Harness rows={ROWS} onRowClick={cb} />);
    fireEvent.keyDown(screen.getByTestId("row-a"), { key: "Tab" });
    fireEvent.keyDown(screen.getByTestId("row-a"), { key: "Escape" });
    fireEvent.keyDown(screen.getByTestId("row-a"), { key: "a" });
    expect(cb).not.toHaveBeenCalled();
  });

  it("Enter on a child <input> does NOT trigger", () => {
    const cb = vi.fn();
    render(<Harness rows={ROWS} onRowClick={cb} />);
    const input = screen.getByTestId("inp-a");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("useRowClickEdit — accessibility attrs", () => {
  it("sets role=button and tabIndex=0 by default", () => {
    render(<Harness rows={ROWS} onRowClick={() => {}} />);
    const row = screen.getByTestId("row-a");
    expect(row.getAttribute("role")).toBe("button");
    expect(row.getAttribute("tabindex")).toBe("0");
  });

  it("uses static aria-label string when provided", () => {
    render(<Harness rows={ROWS} onRowClick={() => {}} ariaLabel="Open the row" />);
    expect(screen.getByTestId("row-a").getAttribute("aria-label")).toBe("Open the row");
  });

  it("uses per-row aria-label function when provided", () => {
    render(
      <Harness
        rows={ROWS}
        onRowClick={() => {}}
        ariaLabel={(r) => `Edit ${r.label}`}
      />,
    );
    expect(screen.getByTestId("row-a").getAttribute("aria-label")).toBe("Edit Alpha");
    expect(screen.getByTestId("row-b").getAttribute("aria-label")).toBe("Edit Bravo");
  });

  it("stamps a data-row-id attribute", () => {
    render(<Harness rows={ROWS} onRowClick={() => {}} />);
    expect(screen.getByTestId("row-a").getAttribute("data-row-id")).toBe("a");
    expect(screen.getByTestId("row-b").getAttribute("data-row-id")).toBe("b");
  });
});

describe("useRowClickEdit — disabled rows", () => {
  it("disabled rows do not fire on click", () => {
    const cb = vi.fn();
    render(
      <Harness
        rows={ROWS}
        onRowClick={cb}
        disabled={(r) => r.id === "a"}
      />,
    );
    fireEvent.click(screen.getByTestId("row-a"));
    expect(cb).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("row-b"));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("disabled rows do not advertise role=button or tabIndex", () => {
    render(
      <Harness
        rows={ROWS}
        onRowClick={() => {}}
        disabled={(r) => r.id === "a"}
      />,
    );
    const row = screen.getByTestId("row-a");
    expect(row.getAttribute("role")).toBeNull();
    expect(row.getAttribute("tabindex")).toBeNull();
  });
});

describe("useRowClickEdit — lastClickedRowId", () => {
  it("starts as null and updates after a click", () => {
    function Probe() {
      const [, force] = React.useReducer((x: number) => x + 1, 0);
      const { getRowProps, lastClickedRowId } = useRowClickEdit<Row>({
        onRowClick: () => force(),
      });
      return (
        <table>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.id} {...getRowProps(r)} data-testid={`row-${r.id}`}>
                <td>{r.label}</td>
              </tr>
            ))}
            <tr>
              <td data-testid="last">{lastClickedRowId() ?? "(none)"}</td>
            </tr>
          </tbody>
        </table>
      );
    }
    render(<Probe />);
    expect(screen.getByTestId("last").textContent).toBe("(none)");
    fireEvent.click(screen.getByTestId("row-b"));
    expect(screen.getByTestId("last").textContent).toBe("b");
    fireEvent.click(screen.getByTestId("row-a"));
    expect(screen.getByTestId("last").textContent).toBe("a");
  });
});

describe("__internal helpers", () => {
  it("INTERACTIVE_SELECTOR includes all expected matchers", () => {
    expect(__internal.INTERACTIVE_SELECTOR).toMatch(/button/);
    expect(__internal.INTERACTIVE_SELECTOR).toMatch(/a\[href\]/);
    expect(__internal.INTERACTIVE_SELECTOR).toMatch(/input/);
    expect(__internal.INTERACTIVE_SELECTOR).toMatch(/select/);
    expect(__internal.INTERACTIVE_SELECTOR).toMatch(/textarea/);
    expect(__internal.INTERACTIVE_SELECTOR).toMatch(/role="button"/);
    expect(__internal.INTERACTIVE_SELECTOR).toMatch(/data-row-click-skip="true"/);
  });

  it("defaultGetRowId uses row.id when present", () => {
    expect(__internal.defaultGetRowId({ id: "xyz", name: "a" })).toBe("xyz");
    expect(__internal.defaultGetRowId({ id: 42 })).toBe("42");
  });

  it("isInteractiveTarget returns false for non-Element targets", () => {
    expect(__internal.isInteractiveTarget(null)).toBe(false);
  });

  it("isInteractiveTarget treats the boundary element itself as non-interactive", () => {
    const tr = document.createElement("tr");
    tr.setAttribute("role", "button");
    document.body.appendChild(tr);
    try {
      expect(__internal.isInteractiveTarget(tr, tr)).toBe(false);
    } finally {
      document.body.removeChild(tr);
    }
  });
});
