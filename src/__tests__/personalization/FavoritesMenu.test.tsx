// @vitest-environment jsdom
//
// Cross-cutter T4 — Unit tests for <FavoritesMenu /> (nav-menu redesign
// 2026-05-30 that replaced FavoritesDrawer).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import FavoritesMenu from "../../components/FavoritesMenu";
import { __resetPersonalizationCacheForTests } from "../../hooks/usePersonalization";

interface MockResponseInit { ok?: boolean; status?: number; body?: unknown }
function mockJsonResponse(init: MockResponseInit = {}): Response {
  const status = init.status ?? 200;
  const ok = init.ok ?? (status >= 200 && status < 300);
  return {
    ok, status, statusText: ok ? "OK" : "ERR",
    json: async () => init.body ?? {},
    text: async () => (init.body ? JSON.stringify(init.body) : ""),
  } as unknown as Response;
}

// FavoritesMenu reads window.location to resolve the current view. jsdom
// defaults to http://localhost/ → detectCurrentView() maps "/" to the DC
// dashboard menu_key, so the "Star this view" row is present.
describe("FavoritesMenu", () => {
  beforeEach(() => {
    __resetPersonalizationCacheForTests();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the nav trigger and stays closed until clicked", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/internal/users/me/preferences") {
        return mockJsonResponse({ body: { favorites: { keys: [] } } });
      }
      throw new Error("unexpected url " + url);
    }));

    render(<FavoritesMenu />);
    await screen.findByTestId("favorites-menu-button");
    // Dropdown not mounted before click.
    expect(screen.queryByTestId("favorites-menu-dropdown")).toBeNull();
  });

  it("opens the dropdown with empty-state + star-this-view row", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/internal/users/me/preferences") {
        return mockJsonResponse({ body: { favorites: { keys: [] } } });
      }
      throw new Error("unexpected url " + url);
    }));

    render(<FavoritesMenu />);
    const btn = await screen.findByTestId("favorites-menu-button");
    await act(async () => { btn.click(); });

    expect(screen.getByTestId("favorites-menu-dropdown")).toBeInTheDocument();
    expect(screen.getByTestId("favorites-menu-empty")).toBeInTheDocument();
    // The current-view star toggle is available (jsdom URL "/" → DC dashboard).
    expect(screen.getByTestId("favorites-menu-star-current")).toBeInTheDocument();
  });

  it("lists favorited views as clickable items", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/internal/users/me/preferences") {
        return mockJsonResponse({ body: { favorites: { keys: ["ats/grid"] } } });
      }
      throw new Error("unexpected url " + url);
    }));

    render(<FavoritesMenu />);
    const btn = await screen.findByTestId("favorites-menu-button");
    await act(async () => { btn.click(); });

    await waitFor(() => {
      expect(screen.getByTestId("favorites-menu-item-ats/grid")).toBeInTheDocument();
    });
  });

  it("stars the current view and fires a favorites PUT", async () => {
    const putBodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/internal/users/me/preferences") {
        return mockJsonResponse({ body: { favorites: { keys: [] } } });
      }
      if (url === "/api/internal/users/me/preferences/favorites") {
        putBodies.push(JSON.parse((init?.body as string) ?? "{}"));
        return mockJsonResponse({ body: {} });
      }
      throw new Error("unexpected url " + url);
    }));

    render(<FavoritesMenu />);
    const btn = await screen.findByTestId("favorites-menu-button");
    await act(async () => { btn.click(); });
    const starRow = await screen.findByTestId("favorites-menu-star-current");
    await act(async () => { starRow.click(); });

    await waitFor(() => {
      expect(putBodies.length).toBe(1);
      expect((putBodies[0] as { keys: string[] }).keys).toContain("dc/dashboard");
    });
  });
});
