import { describe, it, expect } from "vitest";
import {
  clamp, scopeReductionPoints, environmentalScore, diversityPoints,
  socialScore, complianceOnTimePoints, disputePoints, governanceScore,
  computeEsgScore,
} from "../esg.js";

describe("clamp", () => {
  it("clamps to [0, 100] by default", () => {
    expect(clamp(-5)).toBe(0);
    expect(clamp(150)).toBe(100);
    expect(clamp(42)).toBe(42);
  });
  it("returns lo for non-finite inputs (defensive default)", () => {
    expect(clamp(NaN)).toBe(0);
    expect(clamp(Infinity)).toBe(0);
  });
});

describe("scopeReductionPoints", () => {
  const base = { scope1_emissions: 10, scope2_emissions: 10, scope3_emissions: 10 }; // total 30
  it("returns 10 when there is no prior report (neutral baseline)", () => {
    expect(scopeReductionPoints(base, null)).toBe(10);
  });
  it("scales by reduction %: 20%+ → 20, 10%+ → 15, 5%+ → 10, >0 → 5, <0 → 0", () => {
    expect(scopeReductionPoints(base, { scope1_emissions: 40, scope2_emissions: 0, scope3_emissions: 0 })).toBe(20); // 30 vs 40 = 25% down
    expect(scopeReductionPoints(base, { scope1_emissions: 34, scope2_emissions: 0, scope3_emissions: 0 })).toBe(15); // ~11.8%
    expect(scopeReductionPoints(base, { scope1_emissions: 32, scope2_emissions: 0, scope3_emissions: 0 })).toBe(10); // ~6.25%
    expect(scopeReductionPoints(base, { scope1_emissions: 30, scope2_emissions: 0, scope3_emissions: 0 })).toBe(5);  // 0%
    expect(scopeReductionPoints(base, { scope1_emissions: 25, scope2_emissions: 0, scope3_emissions: 0 })).toBe(0);  // +20%
  });
});

describe("environmentalScore", () => {
  it("base 50 + components, capped at 100", () => {
    const r = environmentalScore({ renewable_energy_pct: 100, waste_diverted_pct: 100, scope1_emissions: 5, scope2_emissions: 0, scope3_emissions: 0 },
      { scope1_emissions: 100, scope2_emissions: 0, scope3_emissions: 0 });
    // base 50 + 20 (scope -95%) + 15 (renewable) + 15 (waste) = 100
    expect(r.value).toBe(100);
    expect(r.parts).toMatchObject({ base: 50, scope_reduction: 20, renewable: 15, waste_diverted: 15 });
  });
  it("baseline 50 when no inputs", () => {
    expect(environmentalScore({}, null).value).toBe(60); // 50 + 10 neutral scope
  });
});

describe("diversityPoints", () => {
  it("returns 30 for verified + types + cert info", () => {
    expect(diversityPoints({ verified: true, business_type: ["women_owned"], certifying_body: "WBENC", certification_number: "W-123" })).toBe(30);
  });
  it("returns 20 for verified only", () => {
    expect(diversityPoints({ verified: true, business_type: [] })).toBe(20);
  });
  it("returns 10 for unverified types-only", () => {
    expect(diversityPoints({ verified: false, business_type: ["minority_owned"] })).toBe(10);
  });
  it("returns 0 for nothing", () => {
    expect(diversityPoints(null)).toBe(0);
    expect(diversityPoints({})).toBe(0);
  });
});

describe("socialScore", () => {
  it("base 50 + diversity + capped certifications", () => {
    const r = socialScore({ certifications: ["iso14001", "bcorp", "sa8000", "fsc", "extra"] }, { verified: true, business_type: ["women_owned"], certifying_body: "WBENC", certification_number: "W-1" });
    // base 50 + 30 (full diversity) + 4*5 (certs capped at 4) = 100
    expect(r.value).toBe(100);
    expect(r.parts.certifications_counted).toBe(4);
  });
  it("floors at 50 when nothing is provided", () => {
    expect(socialScore({}, null).value).toBe(50);
  });
});

describe("governance components", () => {
  it("complianceOnTimePoints scales linearly to 20", () => {
    expect(complianceOnTimePoints({ required_count: 0, approved_count: 0 })).toBe(10);
    expect(complianceOnTimePoints({ required_count: 10, approved_count: 10 })).toBe(20);
    expect(complianceOnTimePoints({ required_count: 10, approved_count: 5 })).toBe(10);
    expect(complianceOnTimePoints({ required_count: 10, approved_count: 0 })).toBe(0);
  });
  it("disputePoints deducts 5 per dispute, floor 0", () => {
    expect(disputePoints(0)).toBe(20);
    expect(disputePoints(1)).toBe(15);
    expect(disputePoints(4)).toBe(0);
    expect(disputePoints(10)).toBe(0);
  });
  it("governanceScore is base 60 + compliance + dispute, capped 100", () => {
    const r = governanceScore({ required_count: 10, approved_count: 10 }, 0);
    expect(r.value).toBe(100);
  });
});

describe("computeEsgScore", () => {
  it("applies 40/30/30 weighting and returns the full breakdown", () => {
    const out = computeEsgScore({
      report: { scope1_emissions: 5, scope2_emissions: 0, scope3_emissions: 0, renewable_energy_pct: 100, waste_diverted_pct: 100, certifications: ["a","b","c","d"] },
      priorReport: { scope1_emissions: 100, scope2_emissions: 0, scope3_emissions: 0 },
      diversity: { verified: true, business_type: ["women_owned"], certifying_body: "WBENC", certification_number: "W-1" },
      compliance: { required_count: 10, approved_count: 10 },
      disputes: 0,
    });
    expect(out.environmental).toBe(100);
    expect(out.social).toBe(100);
    expect(out.governance).toBe(100);
    expect(out.overall).toBe(100);
    expect(out.breakdown.weights).toEqual({ environmental: 0.4, social: 0.3, governance: 0.3 });
  });

  it("mid-range values compose correctly", () => {
    const out = computeEsgScore({
      report: { renewable_energy_pct: 50, waste_diverted_pct: 50 },
      priorReport: null,
      diversity: { verified: false, business_type: [] },
      compliance: { required_count: 10, approved_count: 5 },
      disputes: 2,
    });
    // env = 50 + 10 (neutral scope) + 7.5 (renewable) + 7.5 (waste) = 75
    // social = 50 + 0 + 0 = 50
    // gov = 60 + 10 + 10 = 80
    // overall = 75*.4 + 50*.3 + 80*.3 = 30 + 15 + 24 = 69
    expect(out.environmental).toBe(75);
    expect(out.social).toBe(50);
    expect(out.governance).toBe(80);
    expect(out.overall).toBe(69);
  });
});
