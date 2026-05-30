// @vitest-environment jsdom
//
// Unit tests for the universal column-visibility primitive — operator
// ask #1 (2026-05-30). Covers:
//
//   • useTablePrefs — initial load, hidden-set toggling, optimistic
//     update, debounced save, reset-to-default
//   • <TablePrefsButton /> — opens popover, toggles checkboxes, reset
//     button restores defaults
//   • shared module cache across consumers (a toggle in one hook
//     instance is visible to another mounted hook for the same tableKey)

import React from "react";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import {
  useTablePrefs,
  TablePrefsButton,
  __resetTablePrefsCacheForTests,
  __peekTablePrefsCacheForTests,
  type ColumnDef,
} from "../TablePrefs";

const TABLE_KEY = "test.panel";
const COLUMNS: ColumnDef[] = [
  { key: "a", label: "Alpha" },
  { key: "b", label: "Bravo" },
  { key: "c", label: "Charlie" },
  { key: "d", label: "Delta", defaultVisible: false },
];

interface MockResponseInit { ok?: boolean; status?: number; body?: unknown }
function mockJsonResponse(init: MockResponseInit = {}): Response {
  const status = init.status ?? 200;
  const ok = init.ok ?? (status >= 200 && status < 300);
  return {
    ok,
    status,
    statusText: ok ? "OK" : "ERR",
    json: async () => init.body ?? {},
    text: async () => (init.body ? JSON.stringify(init.body) : ""),
  } as unknown as Response;
}

/** Inspect the visible columns by exposing the hook's output as data attrs. */
function HookProbe({ tableKey, columns }: { tableKey: string; columns: ColumnDef[] }) {
  const { visibleColumns, toggleColumn, resetToDefault, isLoading, error } =
    useTablePrefs(tableKey, columns);
  return (
    <div>
      <div data-testid="visible">{Array.from(visibleColumns).sort().join(",")}</div>
      <div data-testid="loading">{String(isLoading)}</div>
      <div data-testid="error">{error ?? ""}</div>
      {columns.map((c) => (
        <button key={c.key} data-testid={`toggle-${c.key}`} onClick={() => toggleColumn(c.key)}>
          toggle {c.key}
        </button>
      ))}
      <button data-testid="reset" onClick={resetToDefault}>reset</button>
    </div>
  );
}

describe("useTablePrefs — initial state + defaults", () => {
  beforeEach(() => {
    __resetTablePrefsCacheForTests();
    // `shouldAdvanceTime` keeps the microtask queue draining so awaited
    // fetches in the component resolve naturally; explicit
    // vi.advanceTimersByTime() still drives the debounced PUT timer.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("hides defaultVisible:false columns when there is no stored pref", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/internal/users/me/preferences") return mockJsonResponse({ body: {} });
      throw new Error("unexpected url " + url);
    }));
    render(<HookProbe tableKey={TABLE_KEY} columns={COLUMNS} />);
    await waitFor(() => {
      expect(screen.getByTestId("visible").textContent).toBe("a,b,c");
    });
  });

  it("honours stored hidden set from GET /preferences", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/internal/users/me/preferences") {
        return mockJsonResponse({
          body: { table_visibility: { tables: { [TABLE_KEY]: ["a", "c"] }, v: 1 } },
        });
      }
      throw new Error("unexpected url " + url);
    }));
    render(<HookProbe tableKey={TABLE_KEY} columns={COLUMNS} />);
    // Stored set replaces defaultHidden — d is no longer auto-hidden.
    await waitFor(() => {
      expect(screen.getByTestId("visible").textContent).toBe("b,d");
    });
  });

  it("exposes loading + error states", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () =>
      mockJsonResponse({ ok: false, status: 500, body: { error: "boom" } }),
    ));
    render(<HookProbe tableKey={TABLE_KEY} columns={COLUMNS} />);
    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("false");
      expect(screen.getByTestId("error").textContent).toMatch(/500/);
    });
  });
});

describe("useTablePrefs — toggling + debounced save", () => {
  beforeEach(() => {
    __resetTablePrefsCacheForTests();
    // `shouldAdvanceTime` keeps the microtask queue draining so awaited
    // fetches in the component resolve naturally; explicit
    // vi.advanceTimersByTime() still drives the debounced PUT timer.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("toggling hides the column optimistically and debounces a single PUT", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/internal/users/me/preferences") return mockJsonResponse({ body: {} });
      if (url === "/api/internal/users/me/preferences/table-visibility") {
        return mockJsonResponse({ body: { key: "table_visibility", value: {} } });
      }
      throw new Error("unexpected url " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<HookProbe tableKey={TABLE_KEY} columns={COLUMNS} />);
    await waitFor(() => {
      expect(screen.getByTestId("visible").textContent).toBe("a,b,c");
    });

    // Rapid burst of toggles: hide b, hide c, then unhide b. Net effect:
    // only c is hidden. PUT should fire once after debounce window.
    act(() => { fireEvent.click(screen.getByTestId("toggle-b")); });
    act(() => { fireEvent.click(screen.getByTestId("toggle-c")); });
    act(() => { fireEvent.click(screen.getByTestId("toggle-b")); });

    expect(screen.getByTestId("visible").textContent).toBe("a,b");
    // Pre-flush: no PUT yet.
    const putCallsBefore = fetchMock.mock.calls.filter(
      (c) => c[0] === "/api/internal/users/me/preferences/table-visibility",
    );
    expect(putCallsBefore).toHaveLength(0);

    // Advance past debounce.
    await act(async () => { vi.advanceTimersByTime(500); });
    const putCalls = fetchMock.mock.calls.filter(
      (c) => c[0] === "/api/internal/users/me/preferences/table-visibility",
    );
    expect(putCalls).toHaveLength(1);
    const body = JSON.parse(putCalls[0]![1]!.body as string);
    // The seed for "no stored pref yet" is the defaultHidden set (just "d"
    // here). After hide-b, hide-c, un-hide-b the persisted hidden set is
    // {d, c} — d carries through because it's defaultVisible:false.
    expect(new Set(body.tables[TABLE_KEY])).toEqual(new Set(["d", "c"]));

    const snap = __peekTablePrefsCacheForTests();
    expect(new Set(snap.hiddenByTable[TABLE_KEY])).toEqual(new Set(["d", "c"]));
  });

  it("resetToDefault clears stored hidden set + reapplies defaultVisible:false", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/internal/users/me/preferences") {
        return mockJsonResponse({
          body: { table_visibility: { tables: { [TABLE_KEY]: ["a"] }, v: 1 } },
        });
      }
      if (url === "/api/internal/users/me/preferences/table-visibility") {
        return mockJsonResponse({ body: { key: "table_visibility", value: {} } });
      }
      throw new Error("unexpected url " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<HookProbe tableKey={TABLE_KEY} columns={COLUMNS} />);
    await waitFor(() => {
      expect(screen.getByTestId("visible").textContent).toBe("b,c,d");
    });

    act(() => { fireEvent.click(screen.getByTestId("reset")); });
    // Defaults kick in: a,b,c visible, d hidden.
    expect(screen.getByTestId("visible").textContent).toBe("a,b,c");

    await act(async () => { vi.advanceTimersByTime(500); });
    const putCalls = fetchMock.mock.calls.filter(
      (c) => c[0] === "/api/internal/users/me/preferences/table-visibility",
    );
    expect(putCalls).toHaveLength(1);
    const body = JSON.parse(putCalls[0]![1]!.body as string);
    // Reset persists the defaultHidden set (just "d").
    expect(body).toEqual({ tables: { [TABLE_KEY]: ["d"] } });
  });

  it("two consumers of the same tableKey share state via the module cache", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/internal/users/me/preferences") return mockJsonResponse({ body: {} });
      if (url === "/api/internal/users/me/preferences/table-visibility") {
        return mockJsonResponse({ body: { key: "table_visibility", value: {} } });
      }
      throw new Error("unexpected url " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    function TwoConsumers() {
      const a = useTablePrefs(TABLE_KEY, COLUMNS);
      const b = useTablePrefs(TABLE_KEY, COLUMNS);
      return (
        <div>
          <div data-testid="visible-a">{Array.from(a.visibleColumns).sort().join(",")}</div>
          <div data-testid="visible-b">{Array.from(b.visibleColumns).sort().join(",")}</div>
          <button data-testid="hide-b" onClick={() => a.toggleColumn("b")}>hide b</button>
        </div>
      );
    }

    render(<TwoConsumers />);
    await waitFor(() => {
      expect(screen.getByTestId("visible-a").textContent).toBe("a,b,c");
      expect(screen.getByTestId("visible-b").textContent).toBe("a,b,c");
    });

    act(() => { fireEvent.click(screen.getByTestId("hide-b")); });
    // Both consumers reflect the toggle.
    expect(screen.getByTestId("visible-a").textContent).toBe("a,c");
    expect(screen.getByTestId("visible-b").textContent).toBe("a,c");

    // Only one GET fired across both mounts (shared in-flight promise).
    const gets = fetchMock.mock.calls.filter(
      (c) => c[0] === "/api/internal/users/me/preferences",
    );
    expect(gets).toHaveLength(1);
  });
});

describe("<TablePrefsButton />", () => {
  beforeEach(() => {
    __resetTablePrefsCacheForTests();
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () =>
      mockJsonResponse({ body: {} }),
    ));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders trigger button + opens popover on click", () => {
    const onToggle = vi.fn();
    const onReset = vi.fn();
    render(
      <TablePrefsButton
        tableKey={TABLE_KEY}
        columns={COLUMNS}
        visibleColumns={new Set(["a", "b", "c"])}
        onToggle={onToggle}
        onReset={onReset}
      />,
    );
    const trigger = screen.getByRole("button", { name: /show\/hide columns/i });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("checkboxes reflect visibleColumns prop", () => {
    render(
      <TablePrefsButton
        tableKey={TABLE_KEY}
        columns={COLUMNS}
        visibleColumns={new Set(["a", "c"])}
        onToggle={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /show\/hide columns/i }));
    const cbA = screen.getByRole("checkbox", { name: /toggle alpha/i }) as HTMLInputElement;
    const cbB = screen.getByRole("checkbox", { name: /toggle bravo/i }) as HTMLInputElement;
    const cbC = screen.getByRole("checkbox", { name: /toggle charlie/i }) as HTMLInputElement;
    const cbD = screen.getByRole("checkbox", { name: /toggle delta/i }) as HTMLInputElement;
    expect(cbA.checked).toBe(true);
    expect(cbB.checked).toBe(false);
    expect(cbC.checked).toBe(true);
    expect(cbD.checked).toBe(false);
  });

  it("clicking a checkbox fires onToggle with the column key", () => {
    const onToggle = vi.fn();
    render(
      <TablePrefsButton
        tableKey={TABLE_KEY}
        columns={COLUMNS}
        visibleColumns={new Set(["a", "b", "c"])}
        onToggle={onToggle}
        onReset={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /show\/hide columns/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /toggle bravo/i }));
    expect(onToggle).toHaveBeenCalledWith("b");
  });

  it("reset button fires onReset and closes the popover", () => {
    const onReset = vi.fn();
    render(
      <TablePrefsButton
        tableKey={TABLE_KEY}
        columns={COLUMNS}
        visibleColumns={new Set(["a", "b", "c"])}
        onToggle={vi.fn()}
        onReset={onReset}
      />,
    );
    const trigger = screen.getByRole("button", { name: /show\/hide columns/i });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: /reset to default/i }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Escape closes the popover", () => {
    render(
      <TablePrefsButton
        tableKey={TABLE_KEY}
        columns={COLUMNS}
        visibleColumns={new Set(["a", "b", "c"])}
        onToggle={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /show\/hide columns/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("clicking outside closes the popover", () => {
    render(
      <div>
        <TablePrefsButton
          tableKey={TABLE_KEY}
          columns={COLUMNS}
          visibleColumns={new Set(["a", "b", "c"])}
          onToggle={vi.fn()}
          onReset={vi.fn()}
        />
        <button>outside</button>
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: /show\/hide columns/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText("outside"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("forwards className + style to the trigger button", () => {
    const { container } = render(
      <TablePrefsButton
        tableKey={TABLE_KEY}
        columns={COLUMNS}
        visibleColumns={new Set(["a"])}
        onToggle={vi.fn()}
        onReset={vi.fn()}
        className="custom-cls"
        style={{ marginLeft: 42 }}
      />,
    );
    const trigger = container.querySelector("button.custom-cls") as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    expect(trigger.style.marginLeft).toBe("42px");
  });
});
