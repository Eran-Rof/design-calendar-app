// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TemplatesModal } from "../modals/TemplatesModal";
import type { SpecTemplate } from "../types";

function template(over: Partial<SpecTemplate> = {}): SpecTemplate {
  return {
    id: "t1", name: "Mens Jeans", category: "Bottoms",
    description: "Block measurements for jeans",
    sizes: ["28", "30", "32", "34", "36"],
    rows: [
      { id: "r1", pointOfMeasure: "Waist", tolerance: "0.5", values: {} },
      { id: "r2", pointOfMeasure: "Inseam", tolerance: "0.5", values: {} },
    ],
    createdAt: "2026-01-01",
    ...over,
  };
}

describe("<TemplatesModal />", () => {
  it("renders the heading + template count", () => {
    render(<TemplatesModal
      allTemplates={[template(), template({ id: "t2", name: "T-Shirt" })]}
      onClose={vi.fn()} onUse={vi.fn()} onDownload={vi.fn()} onUpload={vi.fn()} onDelete={vi.fn()}
    />);
    expect(screen.getByText("Spec Sheet Templates")).toBeInTheDocument();
    expect(screen.getByText("2 templates")).toBeInTheDocument();
  });

  it("singular 'template' when only one", () => {
    render(<TemplatesModal
      allTemplates={[template()]}
      onClose={vi.fn()} onUse={vi.fn()} onDownload={vi.fn()} onUpload={vi.fn()} onDelete={vi.fn()}
    />);
    expect(screen.getByText("1 template")).toBeInTheDocument();
  });

  it("renders the empty state when no templates", () => {
    render(<TemplatesModal
      allTemplates={[]}
      onClose={vi.fn()} onUse={vi.fn()} onDownload={vi.fn()} onUpload={vi.fn()} onDelete={vi.fn()}
    />);
    expect(screen.getByText(/No templates yet/)).toBeInTheDocument();
  });

  it("renders per-template chips: category, POM count, size summary", () => {
    render(<TemplatesModal
      allTemplates={[template({ category: "Bottoms" })]}
      onClose={vi.fn()} onUse={vi.fn()} onDownload={vi.fn()} onUpload={vi.fn()} onDelete={vi.fn()}
    />);
    expect(screen.getByText("Bottoms")).toBeInTheDocument();
    expect(screen.getByText("2 POMs")).toBeInTheDocument();
  });

  it("size summary shows the comma list when ≤ 6 sizes", () => {
    render(<TemplatesModal
      allTemplates={[template({ sizes: ["XS", "S", "M", "L"] })]}
      onClose={vi.fn()} onUse={vi.fn()} onDownload={vi.fn()} onUpload={vi.fn()} onDelete={vi.fn()}
    />);
    expect(screen.getByText("XS, S, M, L")).toBeInTheDocument();
  });

  it("size summary collapses to range when > 6 sizes", () => {
    render(<TemplatesModal
      allTemplates={[template({ sizes: ["28", "30", "32", "34", "36", "38", "40"] })]}
      onClose={vi.fn()} onUse={vi.fn()} onDownload={vi.fn()} onUpload={vi.fn()} onDelete={vi.fn()}
    />);
    expect(screen.getByText("28–40 (7 sizes)")).toBeInTheDocument();
  });

  it("Use Template fires onUse with that template", () => {
    const onUse = vi.fn();
    render(<TemplatesModal
      allTemplates={[template({ id: "t1" })]}
      onClose={vi.fn()} onUse={onUse} onDownload={vi.fn()} onUpload={vi.fn()} onDelete={vi.fn()}
    />);
    // Both the section title + the button read "Use Template" — disambiguate
    fireEvent.click(screen.getByRole("button", { name: "Use Template" }));
    expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }));
  });

  it("Delete button only renders on non-builtin templates", () => {
    render(<TemplatesModal
      allTemplates={[
        template({ id: "user1", name: "Custom", isBuiltin: false }),
        template({ id: "built1", name: "Built", isBuiltin: true }),
      ]}
      onClose={vi.fn()} onUse={vi.fn()} onDownload={vi.fn()} onUpload={vi.fn()} onDelete={vi.fn()}
    />);
    // Only 1 trash button (the non-builtin)
    expect(screen.getAllByText("Delete").length).toBe(1);
  });

  it("Delete fires onDelete with the deleted template", () => {
    const onDelete = vi.fn();
    render(<TemplatesModal
      allTemplates={[template({ id: "u1", name: "Custom", isBuiltin: false })]}
      onClose={vi.fn()} onUse={vi.fn()} onDownload={vi.fn()} onUpload={vi.fn()} onDelete={onDelete}
    />);
    fireEvent.click(screen.getByText("Delete"));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "u1" }));
  });

  it("Built-in badge shows on isBuiltin templates", () => {
    render(<TemplatesModal
      allTemplates={[template({ id: "b1", isBuiltin: true })]}
      onClose={vi.fn()} onUse={vi.fn()} onDownload={vi.fn()} onUpload={vi.fn()} onDelete={vi.fn()}
    />);
    expect(screen.getByText("Built-in")).toBeInTheDocument();
  });
});
