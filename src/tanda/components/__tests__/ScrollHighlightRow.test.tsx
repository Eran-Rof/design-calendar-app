// @vitest-environment jsdom
//
// Tests for the universal scroll-highlight wrapper
// (operator ask #4 — see src/tanda/components/ScrollHighlightRow.tsx).
//
// Coverage:
//   • renders children inside a <tr>
//   • forwards rowId to data-row-id
//   • applies the highlight class only when highlightedRowId matches
//   • bumps data-highlight-tick when the row becomes highlighted (so the
//     CSS keyframe replays)
//   • does NOT apply the highlight when highlightedRowId is null/different
//   • passes through arbitrary html attributes (e.g. title, data-testid)
//   • honours the fadeMs prop via the CSS custom property

import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ScrollHighlightRow from "../ScrollHighlightRow";

function wrap(ui: React.ReactNode) {
  return (
    <table>
      <tbody>{ui}</tbody>
    </table>
  );
}

describe("<ScrollHighlightRow />", () => {
  it("renders children inside a <tr>", () => {
    render(
      wrap(
        <ScrollHighlightRow rowId="a" highlightedRowId={null}>
          <td>hello</td>
        </ScrollHighlightRow>,
      ),
    );
    expect(screen.getByText("hello").closest("tr")).not.toBeNull();
  });

  it("stamps data-row-id with the rowId", () => {
    render(
      wrap(
        <ScrollHighlightRow rowId="row-42" highlightedRowId={null}>
          <td>x</td>
        </ScrollHighlightRow>,
      ),
    );
    const tr = screen.getByText("x").closest("tr")!;
    expect(tr.getAttribute("data-row-id")).toBe("row-42");
  });

  it("does NOT apply tanda-row--highlighted when highlightedRowId is null", () => {
    render(
      wrap(
        <ScrollHighlightRow rowId="a" highlightedRowId={null}>
          <td>x</td>
        </ScrollHighlightRow>,
      ),
    );
    const tr = screen.getByText("x").closest("tr")!;
    expect(tr.className).not.toMatch(/tanda-row--highlighted/);
    expect(tr.getAttribute("data-highlight-tick")).toBeNull();
  });

  it("does NOT apply tanda-row--highlighted when highlightedRowId does not match", () => {
    render(
      wrap(
        <ScrollHighlightRow rowId="a" highlightedRowId="b">
          <td>x</td>
        </ScrollHighlightRow>,
      ),
    );
    const tr = screen.getByText("x").closest("tr")!;
    expect(tr.className).not.toMatch(/tanda-row--highlighted/);
  });

  it("applies tanda-row--highlighted when highlightedRowId matches", () => {
    render(
      wrap(
        <ScrollHighlightRow rowId="a" highlightedRowId="a">
          <td>x</td>
        </ScrollHighlightRow>,
      ),
    );
    const tr = screen.getByText("x").closest("tr")!;
    expect(tr.className).toMatch(/tanda-row--highlighted/);
  });

  it("bumps data-highlight-tick on becoming highlighted", () => {
    const { rerender } = render(
      wrap(
        <ScrollHighlightRow rowId="a" highlightedRowId={null}>
          <td>x</td>
        </ScrollHighlightRow>,
      ),
    );
    rerender(
      wrap(
        <ScrollHighlightRow rowId="a" highlightedRowId="a">
          <td>x</td>
        </ScrollHighlightRow>,
      ),
    );
    const tr = screen.getByText("x").closest("tr")!;
    // Tick goes from 0 → 1 on the effect that fires when isHighlighted flips
    // to true. We assert it is >= 1.
    const tick = Number(tr.getAttribute("data-highlight-tick"));
    expect(tick).toBeGreaterThanOrEqual(1);
  });

  it("re-bumps data-highlight-tick when re-clicking the same row", () => {
    // Simulate the same-row-clicked-twice case: highlightedRowId stays
    // "a", but a parent state change forces re-render. The hook's effect
    // increments tick only when isHighlighted FLIPS to true; this test
    // documents that explicit behaviour by toggling null→a→null→a.
    const { rerender } = render(
      wrap(
        <ScrollHighlightRow rowId="a" highlightedRowId={null}>
          <td>x</td>
        </ScrollHighlightRow>,
      ),
    );
    rerender(
      wrap(
        <ScrollHighlightRow rowId="a" highlightedRowId="a">
          <td>x</td>
        </ScrollHighlightRow>,
      ),
    );
    const tickAfterFirst = Number(
      screen.getByText("x").closest("tr")!.getAttribute("data-highlight-tick"),
    );
    rerender(
      wrap(
        <ScrollHighlightRow rowId="a" highlightedRowId={null}>
          <td>x</td>
        </ScrollHighlightRow>,
      ),
    );
    rerender(
      wrap(
        <ScrollHighlightRow rowId="a" highlightedRowId="a">
          <td>x</td>
        </ScrollHighlightRow>,
      ),
    );
    const tickAfterSecond = Number(
      screen.getByText("x").closest("tr")!.getAttribute("data-highlight-tick"),
    );
    expect(tickAfterSecond).toBeGreaterThan(tickAfterFirst);
  });

  it("passes through arbitrary props to the underlying <tr>", () => {
    render(
      wrap(
        <ScrollHighlightRow
          rowId="a"
          highlightedRowId={null}
          title="row title"
          data-testid="my-row"
          onClick={() => {}}
        >
          <td>x</td>
        </ScrollHighlightRow>,
      ),
    );
    const tr = screen.getByTestId("my-row");
    expect(tr.getAttribute("title")).toBe("row title");
  });

  it("exposes fadeMs through the --tanda-row-fade-ms CSS custom property", () => {
    render(
      wrap(
        <ScrollHighlightRow rowId="a" highlightedRowId="a" fadeMs={1500}>
          <td>x</td>
        </ScrollHighlightRow>,
      ),
    );
    const tr = screen.getByText("x").closest("tr") as HTMLElement;
    expect(tr.style.getPropertyValue("--tanda-row-fade-ms")).toBe("1500ms");
  });

  it("defaults fadeMs to 2000ms when not provided", () => {
    render(
      wrap(
        <ScrollHighlightRow rowId="a" highlightedRowId="a">
          <td>x</td>
        </ScrollHighlightRow>,
      ),
    );
    const tr = screen.getByText("x").closest("tr") as HTMLElement;
    expect(tr.style.getPropertyValue("--tanda-row-fade-ms")).toBe("2000ms");
  });

  it("uses the default scroll-highlight-row testid when none provided", () => {
    render(
      wrap(
        <ScrollHighlightRow rowId="a" highlightedRowId={null}>
          <td>x</td>
        </ScrollHighlightRow>,
      ),
    );
    expect(screen.getByTestId("scroll-highlight-row")).toBeInTheDocument();
  });

  it("merges className from props with the built-in classes", () => {
    render(
      wrap(
        <ScrollHighlightRow rowId="a" highlightedRowId={null} className="extra-thing">
          <td>x</td>
        </ScrollHighlightRow>,
      ),
    );
    const tr = screen.getByText("x").closest("tr")!;
    expect(tr.className).toMatch(/tanda-row/);
    expect(tr.className).toMatch(/tanda-row--clickable/);
    expect(tr.className).toMatch(/extra-thing/);
  });
});

