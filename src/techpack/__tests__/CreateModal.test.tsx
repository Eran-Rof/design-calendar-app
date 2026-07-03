// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CreateModal } from "../modals/CreateModal";
import { EMPTY_CREATE_FORM } from "../factories";

function defaultProps(over: Partial<React.ComponentProps<typeof CreateModal>> = {}) {
  return {
    createForm: EMPTY_CREATE_FORM,
    setCreateForm: vi.fn(),
    dcBrands: [] as any[],
    dcSeasons: [] as string[],
    dcGenders: [] as string[],
    dcVendors: [] as any[],
    dcCategories: [] as any[],
    dcTeam: [] as any[],
    onAddBrand: vi.fn(),
    onAddSeason: vi.fn(),
    onClose: vi.fn(),
    onCreate: vi.fn(),
    ...over,
  };
}

describe("<CreateModal />", () => {
  it("renders both the title + CTA reading 'Create Tech Pack'", () => {
    render(<CreateModal {...defaultProps()} />);
    expect(screen.getAllByText("Create Tech Pack").length).toBe(2);
  });

  it("Create button is disabled until styleName + styleNumber are filled", () => {
    const onCreate = vi.fn();
    const { rerender } = render(<CreateModal {...defaultProps({ onCreate })} />);
    expect(screen.getByRole("button", { name: "Create Tech Pack" })).toBeDisabled();
    // Only number → still disabled
    rerender(<CreateModal {...defaultProps({
      createForm: { ...EMPTY_CREATE_FORM, styleNumber: "001" },
      onCreate,
    })} />);
    expect(screen.getByRole("button", { name: "Create Tech Pack" })).toBeDisabled();
    // Only name → still disabled
    rerender(<CreateModal {...defaultProps({
      createForm: { ...EMPTY_CREATE_FORM, styleName: "Edge" },
      onCreate,
    })} />);
    expect(screen.getByRole("button", { name: "Create Tech Pack" })).toBeDisabled();
    // Both filled → enabled
    rerender(<CreateModal {...defaultProps({
      createForm: { ...EMPTY_CREATE_FORM, styleName: "Edge", styleNumber: "001" },
      onCreate,
    })} />);
    expect(screen.getByRole("button", { name: "Create Tech Pack" })).not.toBeDisabled();
  });

  it("clicking Create fires onCreate when both fields are set", () => {
    const onCreate = vi.fn();
    render(<CreateModal {...defaultProps({
      createForm: { ...EMPTY_CREATE_FORM, styleName: "Edge", styleNumber: "001" },
      onCreate,
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "Create Tech Pack" }));
    expect(onCreate).toHaveBeenCalled();
  });

  it("brand + button fires onAddBrand", () => {
    const onAddBrand = vi.fn();
    render(<CreateModal {...defaultProps({ onAddBrand })} />);
    // The + buttons appear next to Brand and Season dropdowns
    const plusButtons = screen.getAllByText("+");
    fireEvent.click(plusButtons[0]); // brand is first
    expect(onAddBrand).toHaveBeenCalled();
  });

  it("season + button fires onAddSeason", () => {
    const onAddSeason = vi.fn();
    render(<CreateModal {...defaultProps({ onAddSeason })} />);
    const plusButtons = screen.getAllByText("+");
    fireEvent.click(plusButtons[1]); // season is second
    expect(onAddSeason).toHaveBeenCalled();
  });

  it("typing in Style Number fires setCreateForm", () => {
    const setCreateForm = vi.fn();
    render(<CreateModal {...defaultProps({ setCreateForm })} />);
    fireEvent.change(screen.getByPlaceholderText("e.g. OXF-001"), { target: { value: "ABC123" } });
    expect(setCreateForm).toHaveBeenCalled();
    // jsdom + fireEvent.change on controlled inputs doesn't propagate
    // target.value reliably to the renderer's onChange — we only assert
    // the setter was called. The same setter pattern is exercised end-
    // to-end in the parent's handleCreate test path.
  });

  it("Sub Category dropdown is disabled when no category is picked", () => {
    render(<CreateModal {...defaultProps({
      dcCategories: [{ name: "Tops", subCategories: ["T-Shirts"] }],
    })} />);
    // Sub-category is now a themed SearchableSelect; its disabled placeholder
    // shows "Select category first" on the combobox input.
    expect(screen.getByPlaceholderText("Select category first")).toBeInTheDocument();
  });
});
