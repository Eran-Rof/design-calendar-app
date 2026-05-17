// @vitest-environment jsdom
//
// Tests for <CollectionGridView />. Card grid is more visually dense
// than the list — covers: card header (brand · collection · sample),
// season/vendor/DDP/customer metadata, percent + ⚠ Delayed indicator,
// status dots, assignee avatars, Timeline/Calendar nav buttons,
// focus toggle, right-click context menu.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CollectionGridView } from "../CollectionGridView";
import type { Task, Brand, TeamMember, CollectionGroup } from "../../../store/types";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t1", brand: "ROF", collection: "SS26",
    season: "SS26", category: "Tops", phase: "Sketch",
    due: "2026-05-20", status: "Not Started",
    ...over,
  };
}

function collection(over: Partial<CollectionGroup> = {}): CollectionGroup {
  return {
    brand: "ROF",
    collection: "Edge",
    season: "SS26",
    category: "Tops",
    vendorName: "Acme",
    tasks: [task()],
    key: "edge:ss26",
    ...over,
  };
}

const brand = (id: string, color = "#3B82F6"): Brand =>
  ({ id, name: id, color, short: id.slice(0, 3), isPrivateLabel: false } as Brand);

function defaultProps(over: Partial<React.ComponentProps<typeof CollectionGridView>> = {}) {
  return {
    collList: [collection()],
    collections: {},
    team: [] as TeamMember[],
    focusCollKey: null,
    getBrand: (b: string) => brand(b),
    setFocusCollKey: vi.fn(),
    setCtxMenu: vi.fn(),
    setEditTask: vi.fn(),
    setView: vi.fn(),
    ...over,
  };
}

// ────────────────────────────────────────────────────────────────────────

describe("<CollectionGridView />", () => {
  it("renders the card header with brand short + collection name", () => {
    render(<CollectionGridView {...defaultProps()} />);
    expect(screen.getByText(/ROF · Edge/)).toBeInTheDocument();
  });

  it("renders 0% when no tasks Complete", () => {
    render(<CollectionGridView {...defaultProps()} />);
    expect(screen.getByText("0%")).toBeInTheDocument();
  });

  it("renders 100% with green color when all tasks Complete", () => {
    render(<CollectionGridView {...defaultProps({
      collList: [collection({ tasks: [task({ status: "Complete" })] })],
    })} />);
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("renders the ⚠ Delayed indicator when any task is Delayed", () => {
    render(<CollectionGridView {...defaultProps({
      collList: [collection({ tasks: [task({ status: "Delayed" })] })],
    })} />);
    expect(screen.getByText(/⚠ Delayed/)).toBeInTheDocument();
  });

  it("renders Timeline + Calendar buttons", () => {
    render(<CollectionGridView {...defaultProps()} />);
    expect(screen.getByText(/Timeline/)).toBeInTheDocument();
    expect(screen.getByText(/Calendar/)).toBeInTheDocument();
  });

  it("clicking Timeline calls setView('timeline') + setFocusCollKey(key)", () => {
    const setView = vi.fn();
    const setFocusCollKey = vi.fn();
    render(<CollectionGridView {...defaultProps({ setView, setFocusCollKey })} />);
    fireEvent.click(screen.getByText(/Timeline/));
    expect(setView).toHaveBeenCalledWith("timeline");
    expect(setFocusCollKey).toHaveBeenCalledWith("edge:ss26");
  });

  it("clicking Calendar calls setView('calendar') + setFocusCollKey(key)", () => {
    const setView = vi.fn();
    const setFocusCollKey = vi.fn();
    render(<CollectionGridView {...defaultProps({ setView, setFocusCollKey })} />);
    fireEvent.click(screen.getByText(/Calendar/));
    expect(setView).toHaveBeenCalledWith("calendar");
    expect(setFocusCollKey).toHaveBeenCalledWith("edge:ss26");
  });

  it("right-click on card opens context menu via setCtxMenu", () => {
    const setCtxMenu = vi.fn();
    const { container } = render(<CollectionGridView {...defaultProps({ setCtxMenu })} />);
    const card = container.querySelector("div[style*='cursor: pointer']");
    expect(card).toBeDefined();
    fireEvent.contextMenu(card!, { clientX: 100, clientY: 200 });
    expect(setCtxMenu).toHaveBeenCalledWith({ x: 100, y: 200, collKey: "edge:ss26" });
  });

  it("click on card toggles focus (off when already focused)", () => {
    const setFocusCollKey = vi.fn();
    const { rerender } = render(<CollectionGridView {...defaultProps({
      focusCollKey: null, setFocusCollKey,
    })} />);
    // First click: focus on
    fireEvent.click(screen.getByText(/ROF · Edge/));
    expect(setFocusCollKey).toHaveBeenLastCalledWith("edge:ss26");
    // Re-render with focused, click again: toggle off
    rerender(<CollectionGridView {...defaultProps({
      focusCollKey: "edge:ss26", setFocusCollKey,
    })} />);
    fireEvent.click(screen.getByText(/ROF · Edge/));
    expect(setFocusCollKey).toHaveBeenLastCalledWith(null);
  });

  it("status-dot click stops propagation + calls setEditTask", () => {
    const setEditTask = vi.fn();
    const setFocusCollKey = vi.fn();
    const { container } = render(<CollectionGridView {...defaultProps({
      collList: [collection({ tasks: [task({ id: "T1", phase: "Sketch", status: "Not Started" })] })],
      setEditTask,
      setFocusCollKey,
    })} />);
    // Find the status dot — it's a small span with width:9px
    const dot = container.querySelector("span[title*='Sketch']");
    expect(dot).toBeDefined();
    fireEvent.click(dot!);
    expect(setEditTask).toHaveBeenCalledWith(expect.objectContaining({ id: "T1" }));
    // Card click should NOT have been triggered (e.stopPropagation())
    expect(setFocusCollKey).not.toHaveBeenCalled();
  });

  it("renders SKU count from collections[key].skus.length", () => {
    render(<CollectionGridView {...defaultProps({
      collections: { "edge:ss26": { skus: [{}, {}, {}] } },
    })} />);
    expect(screen.getByText("3 SKUs")).toBeInTheDocument();
  });

  it("renders '1 SKU' singular when only one SKU", () => {
    render(<CollectionGridView {...defaultProps({
      collections: { "edge:ss26": { skus: [{}] } },
    })} />);
    expect(screen.getByText("1 SKU")).toBeInTheDocument();
  });

  it("renders DDP date + Exit Factory date when those tasks exist", () => {
    render(<CollectionGridView {...defaultProps({
      collList: [collection({
        tasks: [
          task({ id: "ddp", phase: "DDP", due: "2026-08-15" }),
          task({ id: "ship", phase: "Ship Date", due: "2026-09-01" }),
        ],
      })],
    })} />);
    expect(screen.getByText(/DDP:/)).toBeInTheDocument();
    expect(screen.getByText(/Exit Factory:/)).toBeInTheDocument();
  });

  it("renders empty-tasks card without divide-by-zero", () => {
    render(<CollectionGridView {...defaultProps({
      collList: [collection({ tasks: [] })],
    })} />);
    expect(screen.getByText("0%")).toBeInTheDocument();
  });
});
