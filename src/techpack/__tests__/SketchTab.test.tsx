// @vitest-environment jsdom
//
// Smoke coverage of <SketchTab />. The underlying callout list
// helpers are already pinned by ../bomOps.test.ts (callout numbering,
// add/remove/update). This file confirms the props wire through —
// + Callout calls updateSelected with a longer callouts array, etc.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SketchTab } from "../tabs/SketchTab";
import { emptyTechPack } from "../factories";
import type { TechPack, SketchCallout } from "../types";

function makeTp(flatSketch?: Partial<TechPack["flatSketch"]>): TechPack {
  const base = emptyTechPack({ name: "Eran" });
  return { ...base, flatSketch: { ...base.flatSketch, ...flatSketch } };
}

describe("<SketchTab />", () => {
  it("renders the heading + both sketch slot labels", () => {
    render(<SketchTab
      tp={makeTp()}
      updateSelected={vi.fn()}
      uploadImage={vi.fn()}
      setLightboxImg={vi.fn()}
      showToast={vi.fn()}
    />);
    expect(screen.getByText("Style Design Detail")).toBeInTheDocument();
    expect(screen.getByText("Front View")).toBeInTheDocument();
    expect(screen.getByText("Back View")).toBeInTheDocument();
  });

  it("renders the 'No callouts yet' empty state on an empty sketch", () => {
    render(<SketchTab
      tp={makeTp()}
      updateSelected={vi.fn()}
      uploadImage={vi.fn()}
      setLightboxImg={vi.fn()}
      showToast={vi.fn()}
    />);
    // Empty callout list message starts with "No callouts yet."
    expect(screen.getByText((c) => c.includes("No callouts yet"))).toBeInTheDocument();
  });

  it("'+ Callout' fires updateSelected with a fresh callout appended", () => {
    const updateSelected = vi.fn();
    render(<SketchTab
      tp={makeTp()}
      updateSelected={updateSelected}
      uploadImage={vi.fn()}
      setLightboxImg={vi.fn()}
      showToast={vi.fn()}
    />);
    fireEvent.click(screen.getByText("+ Callout"));
    const arg = updateSelected.mock.calls[0][0];
    expect(arg.flatSketch.callouts).toHaveLength(1);
    expect(arg.flatSketch.callouts[0].number).toBe(1);
  });

  it("editing a callout description calls updateSelected with the merged callout", () => {
    const updateSelected = vi.fn();
    const callout: SketchCallout = { id: "c1", number: 1, description: "" };
    render(<SketchTab
      tp={makeTp({ callouts: [callout] })}
      updateSelected={updateSelected}
      uploadImage={vi.fn()}
      setLightboxImg={vi.fn()}
      showToast={vi.fn()}
    />);
    fireEvent.change(screen.getByPlaceholderText("Detail 1..."), { target: { value: "Hem stitch" } });
    const arg = updateSelected.mock.calls[0][0];
    expect(arg.flatSketch.callouts[0].description).toBe("Hem stitch");
  });

  it("clicking a callout's Delete removes it from the list", () => {
    const updateSelected = vi.fn();
    render(<SketchTab
      tp={makeTp({
        callouts: [
          { id: "c1", number: 1, description: "a" },
          { id: "c2", number: 2, description: "b" },
        ],
      })}
      updateSelected={updateSelected}
      uploadImage={vi.fn()}
      setLightboxImg={vi.fn()}
      showToast={vi.fn()}
    />);
    const removes = screen.getAllByText("Delete");
    fireEvent.click(removes[0]);
    const arg = updateSelected.mock.calls[0][0];
    expect(arg.flatSketch.callouts.map((c: SketchCallout) => c.id)).toEqual(["c2"]);
  });

  it("editing the measurement-size input + stitching textarea both flow through", () => {
    const updateSelected = vi.fn();
    render(<SketchTab
      tp={makeTp()}
      updateSelected={updateSelected}
      uploadImage={vi.fn()}
      setLightboxImg={vi.fn()}
      showToast={vi.fn()}
    />);
    fireEvent.change(screen.getByPlaceholderText("32"), { target: { value: "M" } });
    expect(updateSelected).toHaveBeenCalledWith({
      flatSketch: expect.objectContaining({ measurementNote: "M" }),
    });
  });

  it("shows the '*MEASUREMENTS BASED ON SIZE X' caption when measurementNote is set", () => {
    render(<SketchTab
      tp={makeTp({ measurementNote: "M" })}
      updateSelected={vi.fn()}
      uploadImage={vi.fn()}
      setLightboxImg={vi.fn()}
      showToast={vi.fn()}
    />);
    expect(screen.getByText(/MEASUREMENTS BASED ON SIZE M/)).toBeInTheDocument();
  });
});
