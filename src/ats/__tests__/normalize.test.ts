import { describe, it, expect } from "vitest";
import { partitionNormChanges, mergeNormDecisions, type NormChange, type NormDecisions } from "../normalize";

const change = (original: string, accepted = true): NormChange => ({
  original,
  normalized: original + "_n",
  sources: ["inventory"],
  accepted,
});

describe("partitionNormChanges", () => {
  it("sends unknown originals to unknown[]", () => {
    const changes = [change("A"), change("B")];
    const decisions: NormDecisions = {};
    const { known, unknown } = partitionNormChanges(changes, decisions);
    expect(known).toHaveLength(0);
    expect(unknown).toHaveLength(2);
  });

  it("pre-fills accepted=true for stored accepts", () => {
    const decisions: NormDecisions = { A: "accept" };
    const { known, unknown } = partitionNormChanges([change("A", false)], decisions);
    expect(known).toHaveLength(1);
    expect(known[0].accepted).toBe(true);
    expect(unknown).toHaveLength(0);
  });

  it("pre-fills accepted=false for stored rejects", () => {
    const decisions: NormDecisions = { A: "reject" };
    const { known } = partitionNormChanges([change("A", true)], decisions);
    expect(known[0].accepted).toBe(false);
  });

  it("splits a mixed batch", () => {
    const decisions: NormDecisions = { A: "accept", B: "reject" };
    const { known, unknown } = partitionNormChanges(
      [change("A"), change("B"), change("C")],
      decisions,
    );
    expect(known.map(c => c.original)).toEqual(["A", "B"]);
    expect(unknown.map(c => c.original)).toEqual(["C"]);
  });
});

describe("mergeNormDecisions", () => {
  it("records accepts and rejects", () => {
    const out = mergeNormDecisions({}, [change("A", true), change("B", false)]);
    expect(out).toEqual({ A: "accept", B: "reject" });
  });

  it("overwrites prior decisions when user changes their mind", () => {
    const prior: NormDecisions = { A: "accept" };
    const out = mergeNormDecisions(prior, [change("A", false)]);
    expect(out.A).toBe("reject");
  });

  it("does not mutate the input", () => {
    const prior: NormDecisions = { A: "accept" };
    const out = mergeNormDecisions(prior, [change("B", true)]);
    expect(out).not.toBe(prior);
    expect(prior).toEqual({ A: "accept" });
    expect(out).toEqual({ A: "accept", B: "accept" });
  });
});
