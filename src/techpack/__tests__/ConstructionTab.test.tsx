// @vitest-environment jsdom
//
// Smoke coverage of <ConstructionTab />: empty state, "+ Add Detail"
// appends a fresh row, editing Area/Detail/Notes pushes updates, ✕
// removes a row.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConstructionTab } from "../tabs/ConstructionTab";
import { emptyTechPack } from "../factories";
import type { TechPack, ConstructionDetail } from "../types";

function detail(over: Partial<ConstructionDetail> = {}): ConstructionDetail {
  return { id: "c1", area: "Front Body", detail: "", notes: "", refImages: [], ...over };
}

function makeTp(construction: ConstructionDetail[] = []): TechPack {
  return { ...emptyTechPack({ name: "Eran" }), construction };
}

describe("<ConstructionTab />", () => {
  it("renders the empty state when no details", () => {
    render(<ConstructionTab
      tp={makeTp()}
      updateSelected={vi.fn()}
      uploadImage={vi.fn()}
      setLightboxImg={vi.fn()}
    />);
    expect(screen.getByText("No construction details yet.")).toBeInTheDocument();
  });

  it("'+ Add Detail' appends a fresh detail row", () => {
    const updateSelected = vi.fn();
    render(<ConstructionTab
      tp={makeTp()}
      updateSelected={updateSelected}
      uploadImage={vi.fn()}
      setLightboxImg={vi.fn()}
    />);
    fireEvent.click(screen.getByText("+ Add Detail"));
    expect(updateSelected).toHaveBeenCalled();
    const arg = updateSelected.mock.calls[0][0];
    expect(arg.construction).toHaveLength(1);
    expect(arg.construction[0]).toMatchObject({ area: "", detail: "", notes: "", refImages: [] });
  });

  it("editing the Area input calls updateSelected with the new value", () => {
    const updateSelected = vi.fn();
    render(<ConstructionTab
      tp={makeTp([detail({ area: "" })])}
      updateSelected={updateSelected}
      uploadImage={vi.fn()}
      setLightboxImg={vi.fn()}
    />);
    fireEvent.change(screen.getByPlaceholderText(/Front Body, Collar/), { target: { value: "Sleeve" } });
    const arg = updateSelected.mock.calls[0][0];
    expect(arg.construction[0].area).toBe("Sleeve");
  });

  it("editing Notes calls updateSelected with the new notes", () => {
    const updateSelected = vi.fn();
    render(<ConstructionTab
      tp={makeTp([detail()])}
      updateSelected={updateSelected}
      uploadImage={vi.fn()}
      setLightboxImg={vi.fn()}
    />);
    fireEvent.change(screen.getByPlaceholderText("Additional notes..."), { target: { value: "Hidden seam" } });
    const arg = updateSelected.mock.calls[0][0];
    expect(arg.construction[0].notes).toBe("Hidden seam");
  });

  it("clicking the row's Delete removes that detail from construction", () => {
    const updateSelected = vi.fn();
    render(<ConstructionTab
      tp={makeTp([detail({ id: "a" }), detail({ id: "b", area: "Sleeve" })])}
      updateSelected={updateSelected}
      uploadImage={vi.fn()}
      setLightboxImg={vi.fn()}
    />);
    const removes = screen.getAllByText("Delete");
    fireEvent.click(removes[0]);
    const arg = updateSelected.mock.calls[0][0];
    expect(arg.construction.map((d: ConstructionDetail) => d.id)).toEqual(["b"]);
  });
});
