// @vitest-environment jsdom
//
// Cross-cutter T4-3 — Unit tests for <FavoriteStar />.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import FavoriteStar from "../../components/FavoriteStar";
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

describe("FavoriteStar", () => {
  beforeEach(() => {
    __resetPersonalizationCacheForTests();
    vi.restoreAllMocks();
  });

  it("renders empty star (☆) for a menuKey NOT in favorites", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/internal/users/me/preferences") {
        return mockJsonResponse({ body: { favorites: { keys: ["powip/grid"] } } });
      }
      throw new Error("unexpected url " + url);
    }));

    render(<FavoriteStar menuKey="ats/grid" />);
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /add to favorites/i });
      expect(btn.textContent).toBe("☆");
      expect(btn.getAttribute("aria-pressed")).toBe("false");
    });
  });

  it("renders filled star (★) when menuKey is favorited", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/internal/users/me/preferences") {
        return mockJsonResponse({ body: { favorites: { keys: ["ats/grid"] } } });
      }
      throw new Error("unexpected url " + url);
    }));

    render(<FavoriteStar menuKey="ats/grid" />);
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /remove from favorites/i });
      expect(btn.textContent).toBe("★");
      expect(btn.getAttribute("aria-pressed")).toBe("true");
    });
  });

  it("toggles favorite on click — empty → filled + PUT fires", async () => {
    const putBodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/internal/users/me/preferences") {
        return mockJsonResponse({ body: {} });
      }
      if (url === "/api/internal/users/me/preferences/favorites") {
        putBodies.push(JSON.parse((init?.body as string) ?? "{}"));
        return mockJsonResponse({ body: { key: "favorites", value: { keys: ["ats/grid"] } } });
      }
      throw new Error("unexpected url " + url);
    }));

    render(<FavoriteStar menuKey="ats/grid" />);
    const btn = await screen.findByRole("button", { name: /add to favorites/i });

    await act(async () => { btn.click(); });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /remove from favorites/i })).toBeInTheDocument();
    });
    expect(putBodies).toEqual([{ keys: ["ats/grid"] }]);
  });
});
