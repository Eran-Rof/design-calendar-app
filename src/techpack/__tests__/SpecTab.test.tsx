// @vitest-environment jsdom
//
// Smoke coverage of <SpecTab />. The underlying measurement-grid
// helpers are pinned by ../specOps.test.ts. This file covers the
// metadata edits + the size-column add/remove flow + measurement
// row add/edit through the component layer.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SpecTab } from "../tabs/SpecTab";
import { emptyTechPack } from "../factories";
import type { TechPack, Measurement } from "../types";

function makeTp(measurements: Measurement[] = []): TechPack {
  return { ...emptyTechPack({ name: "Eran" }), measurements };
}

function defaultProps(over: Partial<React.ComponentProps<typeof SpecTab>> = {}) {
  return {
    tp: makeTp(),
    updateSelected: vi.fn(),
    showAddSize: false,
    setShowAddSize: vi.fn(),
    newSize: "",
    setNewSize: vi.fn(),
    ...over,
  };
}

describe("<SpecTab /> — metadata form", () => {
  it("renders Style Info heading + Designer/Brand/Season/Active fields", () => {
    render(<SpecTab {...defaultProps()} />);
    expect(screen.getByText("Style Info")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Designer name")).toBeInTheDocument();
    expect(screen.getByText("Brand")).toBeInTheDocument();
    expect(screen.getByText("Season")).toBeInTheDocument();
  });

  it("editing Designer flows through updateSelected", () => {
    const updateSelected = vi.fn();
    render(<SpecTab {...defaultProps({ updateSelected })} />);
    fireEvent.change(screen.getByPlaceholderText("Designer name"), { target: { value: "Maya" } });
    expect(updateSelected).toHaveBeenCalledWith({ designer: "Maya" });
  });

  it("Active toggle flips between true and false", () => {
    const updateSelected = vi.fn();
    render(<SpecTab {...defaultProps({ updateSelected })} />);
    // Default tp.active === true → button text "Yes"
    fireEvent.click(screen.getByText("Yes"));
    expect(updateSelected).toHaveBeenCalledWith({ active: false });
  });
});

describe("<SpecTab /> — measurements grid", () => {
  it("renders the 'No measurements yet' empty state when no rows", () => {
    render(<SpecTab {...defaultProps()} />);
    expect(screen.getByText(/No measurements yet/)).toBeInTheDocument();
  });

  it("'+ Measurement' appends a fresh measurement row with default sizes", () => {
    const updateSelected = vi.fn();
    render(<SpecTab {...defaultProps({ updateSelected })} />);
    fireEvent.click(screen.getByText("+ Measurement"));
    const arg = updateSelected.mock.calls[0][0];
    expect(arg.measurements).toHaveLength(1);
    expect(Object.keys(arg.measurements[0].sizes).length).toBeGreaterThan(0);
  });

  it("'+ Size Column' button toggles showAddSize on", () => {
    const setShowAddSize = vi.fn();
    render(<SpecTab {...defaultProps({ setShowAddSize })} />);
    fireEvent.click(screen.getByText("+ Size Column"));
    expect(setShowAddSize).toHaveBeenCalledWith(true);
  });

  it("when showAddSize=true, an 'Add' button adds the typed size to every row", () => {
    const updateSelected = vi.fn();
    const setShowAddSize = vi.fn();
    const setNewSize = vi.fn();
    render(<SpecTab {...defaultProps({
      tp: makeTp([{
        id: "m1", pointOfMeasure: "Chest", tolerance: "±0.5", sizes: { S: "20" },
      }]),
      showAddSize: true,
      newSize: "M",
      updateSelected,
      setShowAddSize,
      setNewSize,
    })} />);
    fireEvent.click(screen.getByText("Add"));
    const arg = updateSelected.mock.calls[0][0];
    expect(arg.measurements[0].sizes).toEqual({ S: "20", M: "" });
    expect(setNewSize).toHaveBeenCalledWith("");
    expect(setShowAddSize).toHaveBeenCalledWith(false);
  });

  it("clicking ✕ on a size column header removes that size from all rows", () => {
    const updateSelected = vi.fn();
    render(<SpecTab {...defaultProps({
      tp: makeTp([{
        id: "m1", pointOfMeasure: "Chest", tolerance: "", sizes: { S: "20", M: "21" },
      }]),
      updateSelected,
    })} />);
    // The ✕ buttons appear inside each size column header
    const xs = screen.getAllByText("✕");
    fireEvent.click(xs[0]);
    const arg = updateSelected.mock.calls[0][0];
    // First size column removed (S), only M remains
    expect(Object.keys(arg.measurements[0].sizes)).toEqual(["M"]);
  });

  it("editing the POM cell calls updateSelected", () => {
    const updateSelected = vi.fn();
    render(<SpecTab {...defaultProps({
      tp: makeTp([{
        id: "m1", pointOfMeasure: "Chest", tolerance: "", sizes: { S: "20" },
      }]),
      updateSelected,
    })} />);
    fireEvent.change(screen.getByPlaceholderText("e.g. Chest"), { target: { value: "Bust" } });
    const arg = updateSelected.mock.calls[0][0];
    expect(arg.measurements[0].pointOfMeasure).toBe("Bust");
  });

  it("clicking Delete on a row removes it", () => {
    const updateSelected = vi.fn();
    render(<SpecTab {...defaultProps({
      tp: makeTp([
        { id: "a", pointOfMeasure: "X", tolerance: "", sizes: { S: "1" } },
        { id: "b", pointOfMeasure: "Y", tolerance: "", sizes: { S: "2" } },
      ]),
      updateSelected,
    })} />);
    const removes = screen.getAllByText("Delete");
    fireEvent.click(removes[0]);
    const arg = updateSelected.mock.calls[0][0];
    expect(arg.measurements.map((m: Measurement) => m.id)).toEqual(["b"]);
  });
});
