// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SpecSheetModal } from "../modals/SpecSheetModal";
import { EMPTY_SPEC_SHEET_FORM } from "../factories";
import type { SpecTemplate, SpecSheet } from "../types";

function defaultProps(over: Partial<React.ComponentProps<typeof SpecSheetModal>> = {}) {
  const dummySS: SpecSheet = {
    id: "x", styleName: "", styleNumber: "", brand: "", season: "",
    category: "", description: "", sizes: [], rows: [],
    createdAt: "2026-01-01", updatedAt: "2026-01-01",
  };
  return {
    ssForm: EMPTY_SPEC_SHEET_FORM,
    setSsForm: vi.fn(),
    activeTemplate: null,
    setActiveTemplate: vi.fn(),
    dcBrands: [] as any[],
    dcSeasons: [] as string[],
    dcCategories: [] as any[],
    dcGenders: [] as string[],
    dcVendors: [] as any[],
    onClose: vi.fn(),
    onCreate: vi.fn(() => dummySS),
    ...over,
  };
}

describe("<SpecSheetModal />", () => {
  it("renders 'New Spec Sheet' title", () => {
    render(<SpecSheetModal {...defaultProps()} />);
    expect(screen.getByText("New Spec Sheet")).toBeInTheDocument();
  });

  it("CTA reads 'Create Spec Sheet' when no template active", () => {
    render(<SpecSheetModal {...defaultProps()} />);
    expect(screen.getByText("Create Spec Sheet")).toBeInTheDocument();
  });

  it("CTA reads 'Create from \"<name>\"' when a template is active", () => {
    const t: SpecTemplate = {
      id: "t1", name: "Mens Jeans", category: "Bottoms", description: "",
      sizes: [], rows: [], createdAt: "2026-01-01",
    };
    render(<SpecSheetModal {...defaultProps({ activeTemplate: t })} />);
    expect(screen.getByText(/Create from "Mens Jeans"/)).toBeInTheDocument();
    expect(screen.getByText(/Using template:/)).toBeInTheDocument();
  });

  it("Create button disabled when styleName empty", () => {
    render(<SpecSheetModal {...defaultProps()} />);
    expect(screen.getByText("Create Spec Sheet")).toBeDisabled();
  });

  it("Create button enabled + fires onCreate when styleName set", () => {
    const onCreate = vi.fn(() => ({} as SpecSheet));
    render(<SpecSheetModal {...defaultProps({
      ssForm: { ...EMPTY_SPEC_SHEET_FORM, styleName: "Edge" },
      onCreate,
    })} />);
    fireEvent.click(screen.getByText("Create Spec Sheet"));
    expect(onCreate).toHaveBeenCalled();
  });

  it("clicking a size-preset button sets ssForm.sizes to the preset's comma-joined value", () => {
    const setSsForm = vi.fn();
    render(<SpecSheetModal {...defaultProps({ setSsForm })} />);
    fireEvent.click(screen.getByText("XS–XXL"));
    const updater = setSsForm.mock.calls[0][0];
    const out = updater(EMPTY_SPEC_SHEET_FORM);
    expect(out.sizes).toBe("XS, S, M, L, XL, XXL");
  });

  it("'✕ Clear' clears the active template", () => {
    const setActiveTemplate = vi.fn();
    const t: SpecTemplate = {
      id: "t1", name: "Test", category: "", description: "",
      sizes: [], rows: [], createdAt: "2026-01-01",
    };
    render(<SpecSheetModal {...defaultProps({
      activeTemplate: t,
      setActiveTemplate,
    })} />);
    fireEvent.click(screen.getByText(/✕ Clear/));
    expect(setActiveTemplate).toHaveBeenCalledWith(null);
  });
});
