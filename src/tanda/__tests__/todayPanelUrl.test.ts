// Today Layer-1 plumbing — buildPanelUrl pure helper.
// The Today page hops panels by rewriting ?m= (+ optional one-shot drill
// params) and dispatching a synthetic popstate. This tests the URL builder
// that decides what lands in the address bar.

import { describe, it, expect } from "vitest";
import { buildPanelUrl, DRILL_PARAM_KEYS } from "../scorecardDrill";

const BASE = "https://apps.example.com/app";

function paramsOf(href: string): URLSearchParams {
  return new URL(href).searchParams;
}

describe("buildPanelUrl", () => {
  it("no drill → bare ?m= panel", () => {
    const href = buildPanelUrl(`${BASE}?m=tanda/today`, "style_master");
    const p = paramsOf(href);
    expect(p.get("m")).toBe("style_master");
    // No drill params leak in.
    for (const k of DRILL_PARAM_KEYS) expect(p.get(k)).toBeNull();
  });

  it("applies each drill param to the URL", () => {
    const href = buildPanelUrl(BASE, "style_master", { scale: "missing" });
    const p = paramsOf(href);
    expect(p.get("m")).toBe("style_master");
    expect(p.get("scale")).toBe("missing");
  });

  it("applies multi-key drills (e.g. cases mine)", () => {
    const href = buildPanelUrl(BASE, "cases", { assignee: "me", status: "open" });
    const p = paramsOf(href);
    expect(p.get("m")).toBe("cases");
    expect(p.get("assignee")).toBe("me");
    expect(p.get("status")).toBe("open");
  });

  it("clears stale drill params from a prior hop so they don't cross-wire", () => {
    const stale = `${BASE}?m=sales_orders&status=draft&vendor=v1&customer=c9`;
    const href = buildPanelUrl(stale, "prepack_matrices", { needed: "1" });
    const p = paramsOf(href);
    expect(p.get("m")).toBe("prepack_matrices");
    expect(p.get("needed")).toBe("1");
    expect(p.get("status")).toBeNull();
    expect(p.get("vendor")).toBeNull();
    expect(p.get("customer")).toBeNull();
  });

  it("skips empty/null drill values", () => {
    const href = buildPanelUrl(BASE, "qc_inspections", { status: "" });
    expect(paramsOf(href).get("status")).toBeNull();
  });

  it("preserves unrelated params (non-drill keys)", () => {
    const href = buildPanelUrl(`${BASE}?theme=dark`, "month_end_close", { month: "2025-11" });
    const p = paramsOf(href);
    expect(p.get("theme")).toBe("dark");
    expect(p.get("month")).toBe("2025-11");
  });
});
