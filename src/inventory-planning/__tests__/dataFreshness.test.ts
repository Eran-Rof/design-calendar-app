import { describe, it, expect } from "vitest";
import { toSignal } from "../admin/services/dataFreshnessService";
import { computeStatus } from "../admin/services/integrationHealthService";
import type { IpFreshnessThreshold, IpIntegrationHealth } from "../admin/types/admin";

const threshold: IpFreshnessThreshold = {
  id: "t", entity_type: "wholesale_forecast",
  max_age_hours: 24, severity: "warning", note: null,
  created_at: "", updated_at: "",
};

describe("toSignal", () => {
  it("fresh within threshold", () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const s = toSignal("x", threshold, oneHourAgo);
    expect(s.severity).toBe("fresh");
  });
  it("stale beyond threshold inherits severity", () => {
    const stale = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
    const s = toSignal("x", threshold, stale);
    expect(s.severity).toBe("warning");
    expect(s.age_hours).toBeGreaterThan(threshold.max_age_hours);
  });
  it("null timestamp → warning (unknown)", () => {
    const s = toSignal("x", threshold, null);
    expect(s.severity).toBe("warning");
    expect(s.last_updated_at).toBeNull();
  });
});

function health(partial: Partial<IpIntegrationHealth>): IpIntegrationHealth {
  return {
    id: "h", system_name: "xoro", endpoint: "sales-history",
    last_attempt_at: null, last_success_at: null, last_error_at: null,
    last_error_message: null, last_rows_synced: null,
    status: "unknown", notes: null,
    created_at: "", updated_at: "",
    ...partial,
  };
}

describe("computeStatus", () => {
  it("never attempted → unknown", () => {
    expect(computeStatus(health({}), 24)).toBe("unknown");
  });
  it("error is newer than success → error", () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 60 * 60 * 1000);
    expect(computeStatus(health({
      last_attempt_at: now.toISOString(),
      last_success_at: earlier.toISOString(),
      last_error_at: now.toISOString(),
    }), 24)).toBe("error");
  });
  it("recent success → healthy", () => {
    const now = new Date();
    expect(computeStatus(health({
      last_attempt_at: now.toISOString(),
      last_success_at: now.toISOString(),
    }), 24)).toBe("healthy");
  });
  it("old success → warning", () => {
    const now = new Date();
    const old = new Date(now.getTime() - 100 * 60 * 60 * 1000);
    expect(computeStatus(health({
      last_attempt_at: now.toISOString(),
      last_success_at: old.toISOString(),
    }), 24)).toBe("warning");
  });
});
