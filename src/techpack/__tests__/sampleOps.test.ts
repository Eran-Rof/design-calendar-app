// Tests for the sample factory + status-transition rule. The
// auto-receiveDate behaviour (set today when status flips to
// Received / Approved / Rejected, unless already set) used to live
// inline inside a select onChange handler — testing it here means
// that subtle rule can't silently regress.

import { describe, it, expect } from "vitest";
import { createEmptySample, updateSampleStatus } from "../sampleOps";
import type { Sample } from "../types";

const TODAY = () => "2026-05-16";

function sample(over: Partial<Sample> = {}): Sample {
  return {
    id: "x", type: "Proto", status: "Requested",
    requestDate: "2026-01-01", receiveDate: null,
    vendor: "", comments: "", images: [], ...over,
  };
}

// ────────────────────────────────────────────────────────────────────────

describe("createEmptySample", () => {
  it("seeds the request date with today() but leaves receiveDate null", () => {
    const s = createEmptySample(TODAY);
    expect(s.requestDate).toBe("2026-05-16");
    expect(s.receiveDate).toBeNull();
  });

  it("starts as a Proto in Requested status", () => {
    const s = createEmptySample(TODAY);
    expect(s.type).toBe("Proto");
    expect(s.status).toBe("Requested");
  });

  it("has an id + empty vendor/comments/images", () => {
    const s = createEmptySample(TODAY);
    expect(s.id).toBeTruthy();
    expect(s.vendor).toBe("");
    expect(s.comments).toBe("");
    expect(s.images).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────

describe("updateSampleStatus", () => {
  it("stamps today on receiveDate when transitioning to Received", () => {
    const out = updateSampleStatus(sample(), "Received", TODAY);
    expect(out.status).toBe("Received");
    expect(out.receiveDate).toBe("2026-05-16");
  });

  it("stamps today on receiveDate when transitioning to Approved", () => {
    const out = updateSampleStatus(sample(), "Approved", TODAY);
    expect(out.receiveDate).toBe("2026-05-16");
  });

  it("stamps today on receiveDate when transitioning to Rejected", () => {
    const out = updateSampleStatus(sample(), "Rejected", TODAY);
    expect(out.receiveDate).toBe("2026-05-16");
  });

  it("preserves existing receiveDate when transitioning to Received", () => {
    const out = updateSampleStatus(sample({ receiveDate: "2026-04-01" }), "Received", TODAY);
    expect(out.receiveDate).toBe("2026-04-01");
  });

  it("does NOT set receiveDate when transitioning to Requested / In Progress", () => {
    const out1 = updateSampleStatus(sample(), "Requested", TODAY);
    const out2 = updateSampleStatus(sample(), "In Progress", TODAY);
    expect(out1.receiveDate).toBeNull();
    expect(out2.receiveDate).toBeNull();
  });

  it("leaves receiveDate alone when going from Received -> Requested", () => {
    const out = updateSampleStatus(sample({ receiveDate: "2026-04-01", status: "Received" }), "Requested", TODAY);
    expect(out.status).toBe("Requested");
    expect(out.receiveDate).toBe("2026-04-01"); // preserved, not nulled
  });

  it("preserves unrelated fields (vendor, comments, type, images)", () => {
    const s = sample({ vendor: "Acme", comments: "Hold for QA", type: "PP", images: ["a.png"] });
    const out = updateSampleStatus(s, "Approved", TODAY);
    expect(out.vendor).toBe("Acme");
    expect(out.comments).toBe("Hold for QA");
    expect(out.type).toBe("PP");
    expect(out.images).toEqual(["a.png"]);
  });

  it("does not mutate the input sample", () => {
    const s = sample();
    const before = JSON.stringify(s);
    updateSampleStatus(s, "Received", TODAY);
    expect(JSON.stringify(s)).toBe(before);
  });
});
