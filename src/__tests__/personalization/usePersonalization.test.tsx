// @vitest-environment jsdom
//
// Cross-cutter T4-3 — Unit tests for usePersonalization hook.
//
// Covers:
//   • initial GET /preferences seeds favorites + homeRoute from the cache
//   • toggleFavorite — adds + removes, PUTs the right body, optimistic UI
//   • setHomeRoute — happy path
//   • logClick — fire-and-forget POST, returns synchronously
//   • Error path — failed PUT rolls back local state + re-throws

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import {
  usePersonalization,
  __resetPersonalizationCacheForTests,
} from "../../hooks/usePersonalization";

function Harness() {
  const p = usePersonalization();
  return (
    <div>
      <span data-testid="loading">{p.loading ? "1" : "0"}</span>
      <span data-testid="error">{p.error ?? ""}</span>
      <span data-testid="favs">{p.favorites.join("|")}</span>
      <span data-testid="home">{p.homeRoute ?? ""}</span>
      <button
        data-testid="toggle-vendors"
        onClick={() => { void p.toggleFavorite("powip/vendors/directory").catch(() => {}); }}
      >toggle vendors</button>
      <button
        data-testid="toggle-grid"
        onClick={() => { void p.toggleFavorite("powip/grid").catch(() => {}); }}
      >toggle grid</button>
      <button
        data-testid="set-home"
        onClick={() => { void p.setHomeRoute("tanda/accounting/journal-entries").catch(() => {}); }}
      >set home</button>
      <button
        data-testid="click"
        onClick={() => p.logClick("ats/grid")}
      >click</button>
    </div>
  );
}

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

describe("usePersonalization", () => {
  beforeEach(() => {
    __resetPersonalizationCacheForTests();
    vi.restoreAllMocks();
  });

  it("seeds favorites + homeRoute from GET /preferences on first mount", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/internal/users/me/preferences") {
        return mockJsonResponse({
          body: {
            favorites:  { keys: ["ats/grid", "powip/grid"], v: 1 },
            home_route: { menu_key: "tanda/accounting/journal-entries", v: 1 },
          },
        });
      }
      throw new Error("unexpected url " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Harness />);
    await waitFor(() => {
      expect(screen.getByTestId("favs").textContent).toBe("ats/grid|powip/grid");
    });
    expect(screen.getByTestId("home").textContent).toBe("tanda/accounting/journal-entries");
    expect(screen.getByTestId("loading").textContent).toBe("0");
    // Exactly ONE GET should fire on first mount even though there are
    // multiple internal renders.
    const calls = fetchMock.mock.calls.filter((c: unknown[]) => c[0] === "/api/internal/users/me/preferences");
    expect(calls.length).toBe(1);
  });

  it("toggleFavorite adds + PUTs the updated array", async () => {
    const putCalls: unknown[] = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/internal/users/me/preferences") {
        return mockJsonResponse({ body: { favorites: { keys: ["ats/grid"], v: 1 } } });
      }
      if (url === "/api/internal/users/me/preferences/favorites") {
        putCalls.push(JSON.parse((init?.body as string) ?? "{}"));
        return mockJsonResponse({ body: { key: "favorites", value: { keys: ["ats/grid", "powip/vendors/directory"] } } });
      }
      throw new Error("unexpected url " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("favs").textContent).toBe("ats/grid"));

    await act(async () => {
      screen.getByTestId("toggle-vendors").click();
    });

    await waitFor(() => {
      expect(screen.getByTestId("favs").textContent).toBe("ats/grid|powip/vendors/directory");
    });
    expect(putCalls).toEqual([
      { keys: ["ats/grid", "powip/vendors/directory"] },
    ]);
  });

  it("toggleFavorite removes when already favorited", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/internal/users/me/preferences") {
        return mockJsonResponse({ body: { favorites: { keys: ["powip/grid"], v: 1 } } });
      }
      if (url === "/api/internal/users/me/preferences/favorites") {
        return mockJsonResponse({ body: { key: "favorites", value: { keys: [] } } });
      }
      throw new Error("unexpected url " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("favs").textContent).toBe("powip/grid"));

    await act(async () => {
      screen.getByTestId("toggle-grid").click();
    });

    await waitFor(() => expect(screen.getByTestId("favs").textContent).toBe(""));
  });

  it("setHomeRoute updates state and PUTs", async () => {
    const putBodies: unknown[] = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/internal/users/me/preferences") {
        return mockJsonResponse({ body: {} });
      }
      if (url === "/api/internal/users/me/preferences/home-route") {
        putBodies.push(JSON.parse((init?.body as string) ?? "{}"));
        return mockJsonResponse({ body: { key: "home_route", value: { menu_key: "tanda/accounting/journal-entries" } } });
      }
      throw new Error("unexpected url " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("0"));

    await act(async () => {
      screen.getByTestId("set-home").click();
    });

    await waitFor(() => {
      expect(screen.getByTestId("home").textContent).toBe("tanda/accounting/journal-entries");
    });
    expect(putBodies).toEqual([{ menu_key: "tanda/accounting/journal-entries" }]);
  });

  it("logClick fires POST without awaiting (returns synchronously)", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/internal/users/me/preferences") {
        return mockJsonResponse({ body: {} });
      }
      if (url === "/api/internal/users/me/menu-click") {
        return mockJsonResponse({ body: { ok: true } });
      }
      throw new Error("unexpected url " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("0"));

    // Synchronous call — no await. Should fire-and-forget.
    act(() => {
      screen.getByTestId("click").click();
    });

    await waitFor(() => {
      const clicks = fetchMock.mock.calls.filter((c: unknown[]) => c[0] === "/api/internal/users/me/menu-click");
      expect(clicks.length).toBe(1);
    });
    const click = fetchMock.mock.calls.find((c: unknown[]) => c[0] === "/api/internal/users/me/menu-click");
    expect(click).toBeDefined();
    const init = (click as unknown[])[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ menu_key: "ats/grid" });
  });

  it("rolls back favorites + surfaces error when PUT fails", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/internal/users/me/preferences") {
        return mockJsonResponse({ body: { favorites: { keys: ["ats/grid"], v: 1 } } });
      }
      if (url === "/api/internal/users/me/preferences/favorites") {
        return mockJsonResponse({ ok: false, status: 500, body: { error: "boom" } });
      }
      throw new Error("unexpected url " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("favs").textContent).toBe("ats/grid"));

    await act(async () => {
      screen.getByTestId("toggle-vendors").click();
    });

    // Must roll back — vendors should NOT remain in favorites.
    await waitFor(() => {
      expect(screen.getByTestId("favs").textContent).toBe("ats/grid");
    });
    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toMatch(/PUT favorites failed/);
    });
  });
});
