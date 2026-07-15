// Tests for the always-visible top-bar universal search bar pure helpers:
// substring highlight, group flattening, and result navigation.

import { describe, it, expect, vi } from "vitest";
import {
  highlightParts,
  flattenGroups,
  navigateToResult,
  type GlobalSearchGroup,
  type GlobalSearchItem,
} from "../../components/TopbarGlobalSearch";

describe("highlightParts", () => {
  it("splits around a case-insensitive match", () => {
    expect(highlightParts("Acme Corp", "cme")).toEqual([
      { t: "A", hit: false },
      { t: "cme", hit: true },
      { t: " Corp", hit: false },
    ]);
  });
  it("marks a leading match", () => {
    expect(highlightParts("CUST-100", "cust")).toEqual([
      { t: "CUST", hit: true },
      { t: "-100", hit: false },
    ]);
  });
  it("returns whole string when no match", () => {
    expect(highlightParts("hello", "zzz")).toEqual([{ t: "hello", hit: false }]);
  });
  it("handles empty text", () => {
    expect(highlightParts("", "x")).toEqual([]);
  });
  it("highlights every occurrence", () => {
    const parts = highlightParts("aXaXa", "x");
    expect(parts.filter((p) => p.hit).length).toBe(2);
  });
});

describe("flattenGroups", () => {
  it("concatenates items across groups in order", () => {
    const groups: GlobalSearchGroup[] = [
      { key: "a", label: "A", items: [{ entity_type: "x", code: "1", label: null, sublabel: null, nav: {} } as GlobalSearchItem] },
      { key: "b", label: "B", items: [
        { entity_type: "y", code: "2", label: null, sublabel: null, nav: {} } as GlobalSearchItem,
        { entity_type: "y", code: "3", label: null, sublabel: null, nav: {} } as GlobalSearchItem,
      ] },
    ];
    expect(flattenGroups(groups).map((i) => i.code)).toEqual(["1", "2", "3"]);
  });
  it("handles empty groups", () => {
    expect(flattenGroups([])).toEqual([]);
  });
});

describe("navigateToResult", () => {
  function fakeWindow(href: string) {
    const assign = vi.fn();
    const pushState = vi.fn();
    const dispatchEvent = vi.fn();
    return {
      win: {
        location: { href, assign },
        history: { pushState },
        dispatchEvent,
      } as unknown as Window,
      assign,
      pushState,
      dispatchEvent,
    };
  }

  it("does a module hop via pushState + popstate with a q seed", () => {
    const { win, pushState, dispatchEvent, assign } = fakeWindow("https://app.test/?m=today");
    const item: GlobalSearchItem = {
      entity_type: "customer",
      code: "CUST-1",
      label: "Acme",
      sublabel: null,
      nav: { module: "customer_master", params: { q: "CUST-1" } },
    };
    navigateToResult(item, win);
    expect(assign).not.toHaveBeenCalled();
    expect(pushState).toHaveBeenCalledTimes(1);
    const pushedUrl = pushState.mock.calls[0][2] as string;
    expect(pushedUrl).toContain("m=customer_master");
    expect(pushedUrl).toContain("q=CUST-1");
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it("clears stale drill params before setting the new module", () => {
    const { win, pushState } = fakeWindow("https://app.test/?m=x&vendor=9&q=old");
    navigateToResult(
      { entity_type: "style", code: "S1", label: null, sublabel: null, nav: { module: "style_master", params: { q: "S1" } } },
      win,
    );
    const pushedUrl = pushState.mock.calls[0][2] as string;
    expect(pushedUrl).not.toContain("vendor=9");
    expect(pushedUrl).not.toContain("q=old");
    expect(pushedUrl).toContain("q=S1");
  });

  it("uses a full same-origin assign for href-based results (tanda_pos)", () => {
    const { win, assign, pushState } = fakeWindow("https://app.test/?m=today");
    navigateToResult(
      { entity_type: "po", code: "PO-9", label: "Vendor", sublabel: "Xoro", nav: { href: "/tanda?po=PO-9" } },
      win,
    );
    expect(assign).toHaveBeenCalledWith("/tanda?po=PO-9");
    expect(pushState).not.toHaveBeenCalled();
  });
});
