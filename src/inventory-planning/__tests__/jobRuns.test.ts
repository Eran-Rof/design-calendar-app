import { describe, it, expect } from "vitest";
import { canJobTransition } from "../jobs/services/jobRunService";

describe("job state machine", () => {
  it("queued → running / cancelled only", () => {
    expect(canJobTransition("queued", "running")).toBe(true);
    expect(canJobTransition("queued", "cancelled")).toBe(true);
    expect(canJobTransition("queued", "succeeded")).toBe(false);
    expect(canJobTransition("queued", "failed")).toBe(false);
  });
  it("running → succeeded / failed / partial_success / cancelled", () => {
    expect(canJobTransition("running", "succeeded")).toBe(true);
    expect(canJobTransition("running", "failed")).toBe(true);
    expect(canJobTransition("running", "partial_success")).toBe(true);
    expect(canJobTransition("running", "cancelled")).toBe(true);
  });
  it("terminal states have no transitions", () => {
    expect(canJobTransition("succeeded", "running")).toBe(false);
    expect(canJobTransition("failed", "running")).toBe(false);
    expect(canJobTransition("cancelled", "running")).toBe(false);
    expect(canJobTransition("partial_success", "running")).toBe(false);
  });
});
