// @vitest-environment jsdom
//
// Smoke coverage of <SpecSheetsView />. Covers the search filter,
// add/import dropdown toggle, "Add New" pre-fills the form via
// setSsForm, delete opens confirm dialog, card click selects.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SpecSheetsView } from "../views/SpecSheetsView";
import type { SpecSheet } from "../types";

function ss(over: Partial<SpecSheet> = {}): SpecSheet {
  return {
    id: "ss1", styleName: "Edge Slim", styleNumber: "RYB001",
    brand: "ROF", season: "SS26", category: "Tops",
    description: "", sizes: ["S", "M"], rows: [],
    createdAt: "2026-01-01", updatedAt: "2026-01-01", ...over,
  };
}

function defaultProps(over: Partial<React.ComponentProps<typeof SpecSheetsView>> = {}) {
  return {
    specSheets: [] as SpecSheet[],
    ssSearch: "",
    setSsSearch: vi.fn(),
    setShowTemplatesModal: vi.fn(),
    setSsForm: vi.fn(),
    setEditingSpecSheet: vi.fn(),
    setShowSpecSheetModal: vi.fn(),
    setSelectedSpecSheet: vi.fn(),
    downloadSpecSheetExcel: vi.fn(),
    saveSpecSheets: vi.fn(),
    setConfirmDialog: vi.fn(),
    onImportFile: vi.fn(),
    ...over,
  };
}

describe("<SpecSheetsView />", () => {
  it("renders the empty state when no sheets", () => {
    render(<SpecSheetsView {...defaultProps()} />);
    expect(screen.getByText(/No spec sheets yet/)).toBeInTheDocument();
  });

  it("renders one card per spec sheet with the styleNumber + styleName", () => {
    render(<SpecSheetsView {...defaultProps({
      specSheets: [ss({ id: "a", styleNumber: "RYB001", styleName: "Edge Slim" })],
    })} />);
    expect(screen.getByText("RYB001")).toBeInTheDocument();
    expect(screen.getByText("Edge Slim")).toBeInTheDocument();
  });

  it("typing in search calls setSsSearch", () => {
    const setSsSearch = vi.fn();
    render(<SpecSheetsView {...defaultProps({ setSsSearch })} />);
    fireEvent.change(screen.getByPlaceholderText("Search spec sheets..."), { target: { value: "edge" } });
    expect(setSsSearch).toHaveBeenCalledWith("edge");
  });

  it("Templates button opens the templates modal", () => {
    const setShowTemplatesModal = vi.fn();
    render(<SpecSheetsView {...defaultProps({ setShowTemplatesModal })} />);
    fireEvent.click(screen.getByText(/Templates/));
    expect(setShowTemplatesModal).toHaveBeenCalledWith(true);
  });

  it("'+ Add / Import' button opens the popover; 'Add New' pre-fills empty form", () => {
    const setSsForm = vi.fn();
    const setShowSpecSheetModal = vi.fn();
    render(<SpecSheetsView {...defaultProps({ setSsForm, setShowSpecSheetModal })} />);
    fireEvent.click(screen.getByText(/Add \/ Import/));
    fireEvent.click(screen.getByText("Add New Spec Sheet"));
    expect(setSsForm).toHaveBeenCalled();
    expect(setShowSpecSheetModal).toHaveBeenCalledWith(true);
  });

  it("clicking a card calls setSelectedSpecSheet", () => {
    const setSelectedSpecSheet = vi.fn();
    render(<SpecSheetsView {...defaultProps({
      specSheets: [ss({ id: "a" })],
      setSelectedSpecSheet,
    })} />);
    fireEvent.click(screen.getByText("Edge Slim"));
    expect(setSelectedSpecSheet).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("Delete on a card opens the delete confirm dialog", () => {
    const setConfirmDialog = vi.fn();
    render(<SpecSheetsView {...defaultProps({
      specSheets: [ss({ id: "a", styleName: "Bartram" })],
      setConfirmDialog,
    })} />);
    fireEvent.click(screen.getByText("Delete"));
    const dialog = setConfirmDialog.mock.calls[0][0];
    expect(dialog.title).toBe("Delete Spec Sheet");
    expect(dialog.message).toContain("Bartram");
  });
});
