// Security sprint (re-rate 2026-07-08) — the dispatcher clamps every
// Access-Control-Allow-Origin header to an allowlist. Handlers historically
// set `*`, which let any website drive the API from a victim's browser.
import { describe, it, expect } from "vitest";
import { resolveCorsOrigin } from "../../dispatch.js";

describe("resolveCorsOrigin", () => {
  it("echoes allowlisted app origins", () => {
    expect(resolveCorsOrigin("https://apps.ringoffire.com")).toBe("https://apps.ringoffire.com");
    expect(resolveCorsOrigin("https://design-calendar-app.vercel.app")).toBe("https://design-calendar-app.vercel.app");
    expect(resolveCorsOrigin("http://localhost:5173")).toBe("http://localhost:5173");
  });

  it("allows Vercel preview deployments of this app", () => {
    expect(resolveCorsOrigin("https://design-calendar-app-abc123-erans-projects.vercel.app"))
      .toBe("https://design-calendar-app-abc123-erans-projects.vercel.app");
  });

  it("clamps foreign origins to the primary app origin (never *)", () => {
    expect(resolveCorsOrigin("https://evil.example.com")).toBe("https://apps.ringoffire.com");
    expect(resolveCorsOrigin("https://design-calendar-app.vercel.app.evil.com")).toBe("https://apps.ringoffire.com");
    expect(resolveCorsOrigin("")).toBe("https://apps.ringoffire.com");
    expect(resolveCorsOrigin(undefined)).toBe("https://apps.ringoffire.com");
    expect(resolveCorsOrigin("*")).toBe("https://apps.ringoffire.com");
  });

  it("does not match lookalike preview hosts", () => {
    expect(resolveCorsOrigin("https://design-calendar-app-x.vercel.app.attacker.io"))
      .toBe("https://apps.ringoffire.com");
    expect(resolveCorsOrigin("http://design-calendar-app-abc-team.vercel.app"))
      .toBe("https://apps.ringoffire.com"); // http (not https) preview is refused
  });
});
