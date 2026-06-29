// @vitest-environment jsdom
//
// Smoke coverage of <MaterialsView />. The filter logic is already
// covered by ../listLogic tests; this verifies the UI wires the
// search + type filter + edit/delete handlers correctly.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MaterialsView } from "../views/MaterialsView";
import type { Material } from "../types";

function mat(over: Partial<Material> = {}): Material {
  return {
    id: "m1", name: "Cotton Twill", type: "Fabric",
    composition: "100% Cotton", weight: "8oz", width: "60\"",
    color: "Indigo", supplier: "MillCo", unitPrice: 4.5,
    moq: "500yd", leadTime: "30d", certifications: ["OEKO-TEX"],
    notes: "", createdAt: "2026-01-01", ...over,
  };
}

function defaultProps(over: Partial<React.ComponentProps<typeof MaterialsView>> = {}) {
  return {
    materials: [] as Material[],
    matSearch: "",
    setMatSearch: vi.fn(),
    matTypeFilter: "",
    setMatTypeFilter: vi.fn(),
    setEditingMaterial: vi.fn(),
    setMatForm: vi.fn(),
    setShowMaterialModal: vi.fn(),
    setConfirmDialog: vi.fn(),
    saveMaterials: vi.fn(),
    downloadMaterialsExcel: vi.fn(),
    ...over,
  };
}

describe("<MaterialsView />", () => {
  it("renders the empty state when no materials", () => {
    render(<MaterialsView {...defaultProps()} />);
    expect(screen.getByText(/No materials found/)).toBeInTheDocument();
  });

  it("renders material rows + the count", () => {
    render(<MaterialsView {...defaultProps({
      materials: [mat({ id: "a", name: "Cotton" }), mat({ id: "b", name: "Polyester", type: "Fabric" })],
    })} />);
    expect(screen.getByText("Cotton")).toBeInTheDocument();
    expect(screen.getByText("Polyester")).toBeInTheDocument();
    expect(screen.getByText("2 materials")).toBeInTheDocument();
  });

  it("typing in search calls setMatSearch", () => {
    const setMatSearch = vi.fn();
    render(<MaterialsView {...defaultProps({ setMatSearch })} />);
    fireEvent.change(screen.getByPlaceholderText("Search materials..."), { target: { value: "twill" } });
    expect(setMatSearch).toHaveBeenCalledWith("twill");
  });

  it("'+ Add Material' opens an empty modal", () => {
    const setEditingMaterial = vi.fn();
    const setMatForm = vi.fn();
    const setShowMaterialModal = vi.fn();
    render(<MaterialsView {...defaultProps({ setEditingMaterial, setMatForm, setShowMaterialModal })} />);
    fireEvent.click(screen.getByText("+ Add Material"));
    expect(setEditingMaterial).toHaveBeenCalledWith(null);
    expect(setShowMaterialModal).toHaveBeenCalledWith(true);
    // setMatForm called with the empty form
    expect(setMatForm).toHaveBeenCalled();
  });

  it("Edit on a row opens edit modal with that material's data + CSV-joined certifications", () => {
    const setEditingMaterial = vi.fn();
    const setMatForm = vi.fn();
    render(<MaterialsView {...defaultProps({
      materials: [mat({ id: "a", certifications: ["OEKO-TEX", "GOTS"] })],
      setEditingMaterial, setMatForm,
    })} />);
    fireEvent.click(screen.getByText("Edit"));
    expect(setEditingMaterial).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    const formArg = setMatForm.mock.calls[0][0];
    expect(formArg.certifications).toBe("OEKO-TEX, GOTS");
  });

  it("Delete on a row opens a confirm dialog with the right title/message", () => {
    const setConfirmDialog = vi.fn();
    render(<MaterialsView {...defaultProps({
      materials: [mat({ id: "a", name: "Cotton" })],
      setConfirmDialog,
    })} />);
    fireEvent.click(screen.getByText("Delete"));
    const dialog = setConfirmDialog.mock.calls[0][0];
    expect(dialog.title).toBe("Delete Material");
    expect(dialog.message).toContain("Cotton");
  });

  it("Excel button calls downloadMaterialsExcel with the full materials list", () => {
    const downloadMaterialsExcel = vi.fn();
    render(<MaterialsView {...defaultProps({
      materials: [mat({ id: "a" })],
      downloadMaterialsExcel,
    })} />);
    fireEvent.click(screen.getByText("Excel"));
    expect(downloadMaterialsExcel).toHaveBeenCalledWith([expect.objectContaining({ id: "a" })]);
  });
});
