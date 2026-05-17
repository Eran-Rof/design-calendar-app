// @vitest-environment jsdom
//
// Integration tests for <CostingTab />. The math itself is covered
// by ../calc.test.ts (21 tests). These tests verify the form wires
// edits back through updateSelected({ costing: recomputeCosting(...) })
// — i.e. typing in FOB recomputes duty/landed/margin on the next
// render.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CostingTab } from "../tabs/CostingTab";
import { emptyTechPack } from "../factories";
import type { TechPack } from "../types";

function makeTp(costing: Partial<TechPack["costing"]> = {}): TechPack {
  const base = emptyTechPack({ name: "Eran" });
  return { ...base, costing: { ...base.costing, ...costing } };
}

describe("<CostingTab />", () => {
  it("renders the section heading", () => {
    render(<CostingTab tp={makeTp()} updateSelected={vi.fn()} />);
    expect(screen.getByText("Costing Breakdown")).toBeInTheDocument();
  });

  it("renders landed-cost summary in $X.XX format", () => {
    render(<CostingTab tp={makeTp({ landedCost: 12.34 })} updateSelected={vi.fn()} />);
    expect(screen.getByText("$12.34")).toBeInTheDocument();
  });

  it("renders margin as percentage with 1-decimal precision", () => {
    render(<CostingTab tp={makeTp({ margin: 52.7 })} updateSelected={vi.fn()} />);
    expect(screen.getByText("52.7%")).toBeInTheDocument();
  });

  it("editing FOB calls updateSelected with the recomputed costing block", () => {
    const updateSelected = vi.fn();
    render(<CostingTab
      tp={makeTp({ fob: 0, dutyRate: 10, freight: 0, insurance: 0, otherCosts: 0 })}
      updateSelected={updateSelected}
    />);
    const fobInput = screen.getAllByRole("spinbutton")[0]; // first number input is FOB
    fireEvent.change(fobInput, { target: { value: "100" } });
    expect(updateSelected).toHaveBeenCalled();
    const arg = updateSelected.mock.calls[0][0];
    expect(arg.costing.fob).toBe(100);
    expect(arg.costing.duty).toBe(10);          // 100 * 10/100
    expect(arg.costing.landedCost).toBe(110);   // 100 + 10
  });

  it("editing retail price recomputes margin via updateSelected", () => {
    const updateSelected = vi.fn();
    render(<CostingTab
      tp={makeTp({ fob: 50, dutyRate: 0, freight: 0, insurance: 0, otherCosts: 0, landedCost: 50, retailPrice: 0, margin: 0 })}
      updateSelected={updateSelected}
    />);
    // Retail input is the 8th number input (FOB, dutyRate, freight, insurance, otherCosts, wholesalePrice, retailPrice)
    const inputs = screen.getAllByRole("spinbutton");
    const retailInput = inputs[6];
    fireEvent.change(retailInput, { target: { value: "100" } });
    const arg = updateSelected.mock.calls[0][0];
    expect(arg.costing.retailPrice).toBe(100);
    expect(arg.costing.margin).toBe(50); // (100 - 50) / 100 * 100
  });

  it("editing the notes textarea calls updateSelected with new notes (other fields preserved)", () => {
    const updateSelected = vi.fn();
    render(<CostingTab
      tp={makeTp({ fob: 50, dutyRate: 10, freight: 5, insurance: 2, otherCosts: 0, notes: "" })}
      updateSelected={updateSelected}
    />);
    const notes = screen.getByPlaceholderText(/Notes about costing/);
    fireEvent.change(notes, { target: { value: "Q3 ask" } });
    const arg = updateSelected.mock.calls[0][0];
    expect(arg.costing.notes).toBe("Q3 ask");
    // Other fields preserved via recomputeCosting
    expect(arg.costing.fob).toBe(50);
    expect(arg.costing.freight).toBe(5);
  });
});
