// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MaterialModal } from "../modals/MaterialModal";
import { EMPTY_MATERIAL_FORM } from "../factories";

describe("<MaterialModal />", () => {
  it("title is 'Add Material' when not editing", () => {
    render(<MaterialModal
      matForm={EMPTY_MATERIAL_FORM}
      setMatForm={vi.fn()}
      editingMaterial={null}
      onClose={vi.fn()}
      onSave={vi.fn()}
    />);
    // Both heading + CTA button render "Add Material" — count both
    expect(screen.getAllByText("Add Material").length).toBe(2);
  });

  it("title is 'Edit Material' + CTA reads 'Update Material' when editing", () => {
    render(<MaterialModal
      matForm={{ ...EMPTY_MATERIAL_FORM, name: "X" }}
      setMatForm={vi.fn()}
      editingMaterial={{
        id: "a", name: "X", type: "Fabric", composition: "", weight: "", width: "",
        color: "", supplier: "", unitPrice: 0, moq: "", leadTime: "",
        certifications: [], notes: "", createdAt: "2026-01-01",
      }}
      onClose={vi.fn()}
      onSave={vi.fn()}
    />);
    expect(screen.getByText("Edit Material")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update Material" })).toBeInTheDocument();
  });

  it("Save button is disabled when name is empty", () => {
    render(<MaterialModal
      matForm={EMPTY_MATERIAL_FORM}
      setMatForm={vi.fn()}
      editingMaterial={null}
      onClose={vi.fn()}
      onSave={vi.fn()}
    />);
    expect(screen.getByRole("button", { name: "Add Material" })).toBeDisabled();
  });

  it("Save button is enabled + fires onSave when name is set", () => {
    const onSave = vi.fn();
    render(<MaterialModal
      matForm={{ ...EMPTY_MATERIAL_FORM, name: "Cotton" }}
      setMatForm={vi.fn()}
      editingMaterial={null}
      onClose={vi.fn()}
      onSave={onSave}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Add Material" }));
    expect(onSave).toHaveBeenCalled();
  });

  it("Cancel button fires onClose", () => {
    const onClose = vi.fn();
    render(<MaterialModal
      matForm={EMPTY_MATERIAL_FORM}
      setMatForm={vi.fn()}
      editingMaterial={null}
      onClose={onClose}
      onSave={vi.fn()}
    />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalled();
  });

  it("typing in Name fires setMatForm", () => {
    const setMatForm = vi.fn();
    render(<MaterialModal
      matForm={EMPTY_MATERIAL_FORM}
      setMatForm={setMatForm}
      editingMaterial={null}
      onClose={vi.fn()}
      onSave={vi.fn()}
    />);
    fireEvent.change(screen.getByPlaceholderText("Material name"), { target: { value: "Cotton" } });
    expect(setMatForm).toHaveBeenCalled();
    // The updater closes over e.target.value at call time; we verify
    // the setter was invoked rather than re-running the updater
    // (jsdom's fireEvent.change-on-controlled-input value propagation
    // is finicky; the renderer's onChange behavior is the same one
    // already exercised by setMatForm consumers elsewhere).
  });
});
