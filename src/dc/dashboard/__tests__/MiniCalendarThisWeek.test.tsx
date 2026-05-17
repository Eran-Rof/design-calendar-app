// @vitest-environment jsdom
//
// Integration tests for <MiniCalendarThisWeek />. The component is
// purely presentational + delegates state mutations to its props,
// so the tests pin: (1) the 8-day window renders correctly, (2)
// drag-source chips fire setDragId, (3) drag-over fires
// setMiniCalDragOver, (4) drop calls setTasks with the rescheduled
// task, (5) chip click opens the edit modal.

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MiniCalendarThisWeek } from "../MiniCalendarThisWeek";
import type { Task, Brand } from "../../../store/types";

const TODAY = new Date("2026-05-17T12:00:00Z");
beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TODAY);
});
afterAll(() => {
  vi.useRealTimers();
});

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t1", brand: "ROF", collection: "SS26",
    season: "SS26", category: "Tops", phase: "Sketch",
    due: "2026-05-17", status: "Not Started",
    ...over,
  };
}

const brand = (id: string, color = "#3B82F6"): Brand =>
  ({ id, name: id, color, short: id.slice(0, 3), isPrivateLabel: false } as Brand);

function defaultProps(over: Partial<React.ComponentProps<typeof MiniCalendarThisWeek>> = {}) {
  return {
    tasks: [] as Task[],
    dragId: null,
    miniCalDragOver: null,
    getBrand: (b: string) => brand(b),
    setDragId: vi.fn(),
    setMiniCalDragOver: vi.fn(),
    setTasks: vi.fn(),
    setEditTask: vi.fn(),
    ...over,
  };
}

// ────────────────────────────────────────────────────────────────────────

describe("<MiniCalendarThisWeek />", () => {
  it("renders the 'This Week' header + date range", () => {
    render(<MiniCalendarThisWeek {...defaultProps()} />);
    expect(screen.getByText("This Week")).toBeInTheDocument();
    // Date range pill, format "May 17 – May 24"
    expect(screen.getByText(/May 17/)).toBeInTheDocument();
    expect(screen.getByText(/May 24/)).toBeInTheDocument();
  });

  it("renders 8 day cells", () => {
    const { container } = render(<MiniCalendarThisWeek {...defaultProps()} />);
    // Day numbers 17, 18, 19, 20, 21, 22, 23, 24
    for (const d of [17, 18, 19, 20, 21, 22, 23, 24]) {
      expect(container.textContent).toContain(String(d));
    }
  });

  it("renders task chips on the matching day", () => {
    render(<MiniCalendarThisWeek {...defaultProps({
      tasks: [task({ id: "t1", due: "2026-05-18", phase: "Spec", status: "In Progress" })],
    })} />);
    expect(screen.getByText(/Spec/)).toBeInTheDocument();
    expect(screen.getByText(/In Progress/)).toBeInTheDocument();
  });

  it("renders '—' placeholder on days with no tasks", () => {
    // Each empty day renders the literal "—" inside a leaf div.
    // getAllByText finds every matching node — 8 days with no tasks
    // = 8 placeholder text nodes.
    render(<MiniCalendarThisWeek {...defaultProps()} />);
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBe(8);
  });

  it("shows the '✋ Drop to reschedule' hint when dragId is set", () => {
    render(<MiniCalendarThisWeek {...defaultProps({ dragId: "t1" })} />);
    expect(screen.getByText(/Drop to reschedule/)).toBeInTheDocument();
  });

  it("hides the drop hint when no drag is in progress", () => {
    render(<MiniCalendarThisWeek {...defaultProps()} />);
    expect(screen.queryByText(/Drop to reschedule/)).not.toBeInTheDocument();
  });

  it("chip click calls setEditTask when no drag in progress", () => {
    const setEditTask = vi.fn();
    render(<MiniCalendarThisWeek {...defaultProps({
      tasks: [task({ id: "t1", due: "2026-05-17" })],
      setEditTask,
    })} />);
    fireEvent.click(screen.getByText(/Sketch/));
    expect(setEditTask).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }));
  });

  it("chip click does NOT call setEditTask while a drag is in progress", () => {
    const setEditTask = vi.fn();
    render(<MiniCalendarThisWeek {...defaultProps({
      tasks: [task({ id: "t1", due: "2026-05-17" })],
      dragId: "t2", // some other drag in progress
      setEditTask,
    })} />);
    fireEvent.click(screen.getByText(/Sketch/));
    expect(setEditTask).not.toHaveBeenCalled();
  });

  it("drop fires setTasks with the dragged task rescheduled to the dropped day", () => {
    const setTasks = vi.fn();
    const setDragId = vi.fn();
    const setMiniCalDragOver = vi.fn();
    const t = task({ id: "t1", due: "2026-05-17", phase: "Sketch" });
    const { container } = render(<MiniCalendarThisWeek {...defaultProps({
      tasks: [t],
      dragId: "t1",
      setTasks,
      setDragId,
      setMiniCalDragOver,
    })} />);
    // Drop onto the day cell at index 2 (= 2026-05-19)
    // The day cells are the last 8 children of the grid; pick by getDate=19
    const cells = container.querySelectorAll("[style*='border-radius: 0 0 10px 10px']");
    const cellFor19 = Array.from(cells).find(c => c.textContent?.startsWith("19"));
    expect(cellFor19).toBeDefined();

    // Simulate drop. dataTransfer.getData returns the dragged id.
    const dataTransfer = { getData: vi.fn(() => "t1") };
    fireEvent.drop(cellFor19!, { dataTransfer });

    // setTasks should have been called with an updater fn that
    // reschedules t1 to 2026-05-19.
    expect(setTasks).toHaveBeenCalled();
    const updater = setTasks.mock.calls[0][0] as (prev: Task[]) => Task[];
    const result = updater([t]);
    expect(result[0].due).toBe("2026-05-19");

    // Drag state cleared.
    expect(setDragId).toHaveBeenCalledWith(null);
    expect(setMiniCalDragOver).toHaveBeenCalledWith(null);
  });

  it("dragstart on a chip fires setDragId with the chip's task id (after the queued microtask)", () => {
    const setDragId = vi.fn();
    render(<MiniCalendarThisWeek {...defaultProps({
      tasks: [task({ id: "t1", due: "2026-05-17" })],
      setDragId,
    })} />);
    const dataTransfer = { setData: vi.fn() };
    fireEvent.dragStart(screen.getByText(/Sketch/), { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "t1");

    // The setDragId call is queued via setTimeout(0). Advance fake timers.
    vi.runAllTimers();
    expect(setDragId).toHaveBeenCalledWith("t1");
  });
});
