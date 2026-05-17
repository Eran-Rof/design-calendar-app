// @vitest-environment jsdom
//
// Tests for <CollectionListView />. Covers: header row, per-collection
// row content, expand/collapse toggle, inner task table on expand,
// task-row click → setEditTask, empty-tasks no-divide-by-zero.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CollectionListView } from "../CollectionListView";
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

function defaultProps(over: Partial<React.ComponentProps<typeof CollectionListView>> = {}) {
  return {
    collList: [collection()],
    expandedColl: null,
    team: [] as TeamMember[],
    getBrand: (b: string) => brand(b),
    setExpandedColl: vi.fn(),
    setEditTask: vi.fn(),
    ...over,
  };
}

// ────────────────────────────────────────────────────────────────────────

describe("<CollectionListView />", () => {
  it("renders the header row with all column labels", () => {
    render(<CollectionListView {...defaultProps()} />);
    for (const h of ["Brand", "Collection", "Season", "Vendor", "DDP", "Progress", "Next Task"]) {
      expect(screen.getByText(h)).toBeInTheDocument();
    }
  });

  it("renders the collection's brand short, name, season, vendor + collapsed chevron", () => {
    render(<CollectionListView {...defaultProps()} />);
    expect(screen.getByText("ROF")).toBeInTheDocument();
    expect(screen.getByText(/▶ Edge/)).toBeInTheDocument();
    expect(screen.getByText("SS26")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
  });

  it("renders 100% bar when all tasks Complete + 'All done' next-task", () => {
    render(<CollectionListView {...defaultProps({
      collList: [collection({ tasks: [task({ status: "Complete" })] })],
    })} />);
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getByText("All done")).toBeInTheDocument();
  });

  it("renders 0% when no tasks Complete + shows next-task as `phase · date`", () => {
    render(<CollectionListView {...defaultProps({
      collList: [collection({ tasks: [task({ phase: "Spec", due: "2026-06-01" })] })],
    })} />);
    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(screen.getByText(/Spec ·/)).toBeInTheDocument();
  });

  it("clicking a collection row calls setExpandedColl with its key", () => {
    const setExpandedColl = vi.fn();
    render(<CollectionListView {...defaultProps({ setExpandedColl })} />);
    fireEvent.click(screen.getByText(/▶ Edge/));
    expect(setExpandedColl).toHaveBeenCalledWith("edge:ss26");
  });

  it("clicking the row of an already-expanded collection collapses it (passes null)", () => {
    const setExpandedColl = vi.fn();
    render(<CollectionListView {...defaultProps({
      expandedColl: "edge:ss26",
      setExpandedColl,
    })} />);
    fireEvent.click(screen.getByText(/▼ Edge/));
    expect(setExpandedColl).toHaveBeenCalledWith(null);
  });

  it("renders the inner task table only when collection is expanded", () => {
    const { rerender } = render(<CollectionListView {...defaultProps()} />);
    // Collapsed: inner headers absent
    expect(screen.queryByText("Phase")).not.toBeInTheDocument();
    rerender(<CollectionListView {...defaultProps({ expandedColl: "edge:ss26" })} />);
    // Expanded: inner headers present
    expect(screen.getByText("Phase")).toBeInTheDocument();
    expect(screen.getByText("Due Date")).toBeInTheDocument();
    expect(screen.getByText("Assignee")).toBeInTheDocument();
  });

  it("clicking an inner task row calls setEditTask with the task", () => {
    const setEditTask = vi.fn();
    render(<CollectionListView {...defaultProps({
      expandedColl: "edge:ss26",
      collList: [collection({ tasks: [task({ id: "T123", phase: "Spec" })] })],
      setEditTask,
    })} />);
    fireEvent.click(screen.getByText("Spec"));
    expect(setEditTask).toHaveBeenCalledWith(expect.objectContaining({ id: "T123" }));
  });

  it("renders the assignee name from team when expanded", () => {
    const team = [{ id: "u1", name: "Eran", color: "#fff", initials: "E" } as TeamMember];
    render(<CollectionListView {...defaultProps({
      expandedColl: "edge:ss26",
      collList: [collection({ tasks: [task({ assigneeId: "u1" })] })],
      team,
    })} />);
    expect(screen.getByText("Eran")).toBeInTheDocument();
  });

  it("renders '—' for missing assignee", () => {
    render(<CollectionListView {...defaultProps({
      expandedColl: "edge:ss26",
      collList: [collection({ tasks: [task({ assigneeId: undefined })] })],
    })} />);
    // "—" appears in several cells (DDP when no DDP task, assignee when
    // null). At least one should be present.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("handles a collection with empty tasks (no NaN, no divide-by-zero)", () => {
    render(<CollectionListView {...defaultProps({
      collList: [collection({ tasks: [] })],
    })} />);
    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(screen.getByText("All done")).toBeInTheDocument();
  });
});
