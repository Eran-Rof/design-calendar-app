// @vitest-environment jsdom
//
// Cross-cutter T4-7 — Unit tests for the redesigned <FavoritesDrawer />.
//
// Covers:
//   • Empty state renders the "no favorites yet" prompt with a hint
//     pointing at the new "Star this view" pill.
//   • Favorites render grouped by their MenuKey.group across the
//     horizontal strip (one column per group, registry order).
//   • Collapse chevron persists collapsed=true via PUT
//     /preferences/drawer-collapsed and the collapsed pill renders.
//   • The "Star this view" pill in the strip header reflects whether
//     the current URL's view is in favorites, and toggling it fires the
//     favorites PUT with the right keys.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import FavoritesDrawer from "../../components/FavoritesDrawer";
import { __resetPersonalizationCacheForTests } from "../../hooks/usePersonalization";
import { __resetFavoritesToastsForTests } from "../../components/favoritesToast";

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

function setLocation(href: string): void {
  // jsdom lets us reassign window.history; we keep this helper so the
  // per-test intent ("pretend we're on /tanda?view=vendors") is loud.
  window.history.replaceState({}, "", href);
}

describe("FavoritesDrawer — horizontal strip layout (T4-7)", () => {
  beforeEach(() => {
    __resetPersonalizationCacheForTests();
    __resetFavoritesToastsForTests();
    window.localStorage.clear();
    setLocation("/tanda?view=dashboard");
    vi.restoreAllMocks();
  });

  it("shows empty state pointing at the Star this view pill", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/internal/users/me/preferences") return mockJsonResponse({ body: {} });
      throw new Error("unexpected url " + url);
    }));

    render(<FavoritesDrawer />);
    await waitFor(() => {
      expect(screen.getByTestId("favorites-empty")).toBeInTheDocument();
      expect(screen.getByTestId("favorites-empty").textContent).toMatch(/Star this view/i);
    });
  });

  it("renders favorites grouped by MenuKey.group across horizontal columns", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/internal/users/me/preferences") {
        return mockJsonResponse({
          body: {
            favorites: {
              keys: [
                "powip/vendors/directory",       // group: Vendors
                "powip/admin/analytics",         // group: Analytics & Admin
                "powip/ops/shipments",           // group: Operations
                "ats/grid",                      // group: Grid
              ],
              v: 1,
            },
          },
        });
      }
      throw new Error("unexpected url " + url);
    }));

    render(<FavoritesDrawer />);
    await waitFor(() => {
      expect(screen.getByTestId("favorites-strip")).toBeInTheDocument();
      // One column per group present in the favorites.
      expect(screen.getByTestId("favorites-column-Vendors")).toBeInTheDocument();
      expect(screen.getByTestId("favorites-column-Operations")).toBeInTheDocument();
      expect(screen.getByTestId("favorites-column-Analytics & Admin")).toBeInTheDocument();
      expect(screen.getByTestId("favorites-column-Grid")).toBeInTheDocument();
      // No empty column for groups with zero favorites.
      expect(screen.queryByTestId("favorites-column-Compliance")).toBeNull();
      // Each item renders inside its group.
      expect(screen.getByTestId("favorites-item-powip/vendors/directory")).toBeInTheDocument();
      expect(screen.getByTestId("favorites-item-powip/ops/shipments")).toBeInTheDocument();
    });
  });

  it("collapse chevron persists collapsed=true via PUT drawer-collapsed", async () => {
    const puts: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/internal/users/me/preferences") return mockJsonResponse({ body: {} });
      if (url === "/api/internal/users/me/preferences/drawer-collapsed") {
        puts.push(JSON.parse((init?.body as string) ?? "{}"));
        return mockJsonResponse({ body: { key: "drawer_collapsed", value: { collapsed: true, v: 1 } } });
      }
      throw new Error("unexpected url " + url);
    }));

    render(<FavoritesDrawer />);
    await waitFor(() => expect(screen.getByTestId("favorites-strip")).toBeInTheDocument());

    await act(async () => {
      screen.getByRole("button", { name: /Collapse favorites strip/i }).click();
    });

    await waitFor(() => {
      expect(screen.getByTestId("favorites-strip-collapsed")).toBeInTheDocument();
      expect(screen.queryByTestId("favorites-strip")).toBeNull();
    });
    expect(puts).toEqual([{ collapsed: true }]);
    // localStorage shadow-copy is updated for offline fast-paint.
    expect(window.localStorage.getItem("favorites_drawer_collapsed")).toBe("1");
  });

  it("Star this view pill reflects current URL + toggles favorite-status", async () => {
    setLocation("/tanda?view=vendors"); // → powip/vendors/directory
    const puts: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/internal/users/me/preferences") return mockJsonResponse({ body: {} });
      if (url === "/api/internal/users/me/preferences/favorites") {
        puts.push(JSON.parse((init?.body as string) ?? "{}"));
        return mockJsonResponse({ body: { key: "favorites", value: { keys: ["powip/vendors/directory"] } } });
      }
      throw new Error("unexpected url " + url);
    }));

    render(<FavoritesDrawer />);

    // Pill starts as ☆ Star this view — Directory
    const pill = await screen.findByTestId("favorites-strip-current-view-toggle");
    expect(pill.getAttribute("aria-pressed")).toBe("false");
    expect(pill.textContent).toMatch(/Star this view/i);
    expect(pill.textContent).toMatch(/Directory/);

    await act(async () => { pill.click(); });

    // After toggle, the pill flips to ★ Unstar + the item appears in the strip.
    await waitFor(() => {
      expect(screen.getByTestId("favorites-strip-current-view-toggle").getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByTestId("favorites-item-powip/vendors/directory")).toBeInTheDocument();
    });
    expect(puts).toEqual([{ keys: ["powip/vendors/directory"] }]);

    // Toast feedback fires.
    expect(screen.getByTestId("favorites-toast-stack").textContent).toMatch(/Added "Directory" to favorites/i);
  });

  it("clicking Unstar pill removes the current view from favorites + toasts Removed", async () => {
    setLocation("/tanda?view=vendors");
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/internal/users/me/preferences") {
        return mockJsonResponse({ body: { favorites: { keys: ["powip/vendors/directory"], v: 1 } } });
      }
      if (url === "/api/internal/users/me/preferences/favorites") {
        return mockJsonResponse({ body: { key: "favorites", value: { keys: [] } } });
      }
      throw new Error("unexpected url " + url);
    }));

    render(<FavoritesDrawer />);
    const pill = await screen.findByTestId("favorites-strip-current-view-toggle");
    await waitFor(() => expect(pill.getAttribute("aria-pressed")).toBe("true"));

    await act(async () => { pill.click(); });

    await waitFor(() => {
      expect(screen.getByTestId("favorites-strip-current-view-toggle").getAttribute("aria-pressed")).toBe("false");
    });
    expect(screen.getByTestId("favorites-toast-stack").textContent).toMatch(/Removed "Directory" from favorites/i);
  });
});
