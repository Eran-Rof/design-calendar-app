// @vitest-environment jsdom
//
// Cross-cutter T4-3 — Unit tests for <FavoritesDrawer />.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import FavoritesDrawer from "../../components/FavoritesDrawer";
import { __resetPersonalizationCacheForTests } from "../../hooks/usePersonalization";

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

describe("FavoritesDrawer", () => {
  beforeEach(() => {
    __resetPersonalizationCacheForTests();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("shows empty state when favorites is empty", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/internal/users/me/preferences") {
        return mockJsonResponse({ body: {} });
      }
      throw new Error("unexpected url " + url);
    }));

    render(<FavoritesDrawer />);
    await waitFor(() => {
      expect(screen.getByTestId("favorites-empty")).toBeInTheDocument();
      expect(screen.getByTestId("favorites-empty").textContent).toMatch(/Star any menu item/i);
    });
  });

  it("renders each favorite menu_key with its label + remove button", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/internal/users/me/preferences") {
        return mockJsonResponse({
          body: { favorites: { keys: ["ats/grid", "tanda/accounting/journal-entries"], v: 1 } },
        });
      }
      throw new Error("unexpected url " + url);
    }));

    render(<FavoritesDrawer />);
    await waitFor(() => {
      // Visible label (registry-driven) renders as button text
      expect(screen.getByRole("button", { name: /^ATS Grid$/ })).toBeInTheDocument();
      // tanda/accounting/journal-entries has icon "📓" before label —
      // visible button text is "📓 Journal Entries".
      expect(screen.getByRole("button", { name: /^📓\s*Journal Entries$/ })).toBeInTheDocument();
      // One remove button per favorite
      expect(screen.getByRole("button", { name: /Remove ATS Grid from favorites/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Remove Journal Entries from favorites/i })).toBeInTheDocument();
    });
  });

  it("collapse state is persisted to localStorage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/internal/users/me/preferences") return mockJsonResponse({ body: {} });
      throw new Error("unexpected url " + url);
    }));

    const { unmount } = render(<FavoritesDrawer />);
    // Default open
    await waitFor(() => expect(screen.getByTestId("favorites-drawer")).toBeInTheDocument());

    // Collapse
    await act(async () => {
      screen.getByRole("button", { name: /Collapse favorites drawer/i }).click();
    });
    await waitFor(() => expect(screen.getByTestId("favorites-drawer-collapsed")).toBeInTheDocument());
    expect(window.localStorage.getItem("favorites_drawer_open")).toBe("0");

    unmount();

    // Remount → must respect persisted "closed" state
    render(<FavoritesDrawer />);
    expect(screen.getByTestId("favorites-drawer-collapsed")).toBeInTheDocument();
    expect(screen.queryByTestId("favorites-drawer")).toBeNull();
  });
});
