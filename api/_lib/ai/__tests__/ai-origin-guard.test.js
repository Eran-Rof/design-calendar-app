// Unit tests for the Ask AI same-origin guard (isAllowedAiOrigin).
// Regression: the custom production domain apps.ringoffire.com was 403'd
// because the static allowlist only had the vercel.app domain.

import { describe, it, expect } from "vitest";
import { isAllowedAiOrigin } from "../../../_handlers/ai/ask-grid.js";

const DEFAULT = [
  "https://apps.ringoffire.com",
  "https://design-calendar-app.vercel.app",
  "http://localhost:5173",
];

describe("isAllowedAiOrigin", () => {
  it("accepts the custom prod domain via the allowlist", () => {
    expect(isAllowedAiOrigin({
      referer: "https://apps.ringoffire.com/tangerine?m=today",
      host: "apps.ringoffire.com",
      allowedOrigins: DEFAULT,
    })).toBe(true);
  });

  it("accepts ANY host as true same-origin (no allowlist entry needed)", () => {
    // A brand-new preview/custom domain not in the allowlist still works when
    // the referer host matches the request's own host.
    expect(isAllowedAiOrigin({
      referer: "https://tangerine-git-feat.vercel.app/x",
      host: "tangerine-git-feat.vercel.app",
      allowedOrigins: [],
    })).toBe(true);
    expect(isAllowedAiOrigin({
      origin: "https://apps.ringoffire.com",
      host: "apps.ringoffire.com",
      allowedOrigins: [],
    })).toBe(true);
  });

  it("accepts localhost dev via the allowlist", () => {
    expect(isAllowedAiOrigin({
      origin: "http://localhost:5173",
      host: "localhost:5173",
      allowedOrigins: DEFAULT,
    })).toBe(true);
  });

  it("rejects a cross-site caller (referer host != our host, not allowlisted)", () => {
    expect(isAllowedAiOrigin({
      referer: "https://evil.example.com/x",
      origin: "https://evil.example.com",
      host: "apps.ringoffire.com",
      allowedOrigins: DEFAULT,
    })).toBe(false);
  });

  it("defeats the subdomain-suffix trick (exact origin match, not prefix)", () => {
    expect(isAllowedAiOrigin({
      referer: "https://apps.ringoffire.com.attacker.com/x",
      origin: "https://apps.ringoffire.com.attacker.com",
      host: "apps.ringoffire.com",
      allowedOrigins: DEFAULT,
    })).toBe(false);
  });

  it("rejects when there is no origin AND no referer", () => {
    expect(isAllowedAiOrigin({ host: "apps.ringoffire.com", allowedOrigins: DEFAULT })).toBe(false);
  });

  it("tolerates a malformed referer without throwing (and rejects it — nothing valid to match)", () => {
    expect(isAllowedAiOrigin({ referer: "::not a url::", host: "apps.ringoffire.com", allowedOrigins: DEFAULT })).toBe(false);
    // A valid same-host origin still passes even when the referer is garbage.
    expect(isAllowedAiOrigin({ origin: "https://apps.ringoffire.com", referer: "::nope::", host: "apps.ringoffire.com", allowedOrigins: [] })).toBe(true);
  });
});
