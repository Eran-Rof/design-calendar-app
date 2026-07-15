// @vitest-environment jsdom
//
// Render tests for <TotalsButton /> — verifies the toggle opens the totals
// strip, money sums render as $, percent columns are skipped, and the button
// hides itself on grids with no numeric columns.

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import TotalsButton from "../TotalsButton";
import { type ExportColumn } from "../useTableExport";

const columns: ExportColumn<Record<string, unknown>>[] = [
  { key: "customer", header: "Customer", format: "text" },
  { key: "gross_cents", header: "Gross", format: "currency_cents" },
  { key: "qty", header: "Qty", format: "number" },
  { key: "margin_pct", header: "Margin %", format: "percent" },
];
const rows = [
  { customer: "A", gross_cents: 12345, qty: 10, margin_pct: 12.5 },
  { customer: "B", gross_cents: 20000, qty: 5, margin_pct: 40 },
];

describe("<TotalsButton />", () => {
  it("toggles the totals strip open and shows summed money + qty", () => {
    render(<TotalsButton rows={rows} columns={columns} />);
    // Closed initially.
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Totals/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("$323.45"); // 12345 + 20000 cents
    expect(dialog.textContent).toContain("15"); // qty 10 + 5
  });

  it("does not sum percent columns and shows the footnote", () => {
    render(<TotalsButton rows={rows} columns={columns} />);
    fireEvent.click(screen.getByRole("button", { name: /Totals/ }));
    const dialog = screen.getByRole("dialog");
    // 52.5 would be the (wrong) sum of the percent column — must NOT appear.
    expect(dialog.textContent).not.toContain("52.5");
    expect(dialog.textContent).toContain("Percentages are not summed");
  });

  it("renders nothing when the table has no numeric columns", () => {
    const { container } = render(
      <TotalsButton
        rows={[{ name: "A", code: "X1" }]}
        columns={[
          { key: "name", header: "Name", format: "text" },
          { key: "code", header: "Code", format: "text" },
        ]}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
