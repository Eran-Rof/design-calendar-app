// Tests for the Xoro GL mirror nightly poster cron handler's PURE decision
// logic (decideAlert). The posting + hard-guard logic itself lives in the SQL
// function xoro_gl_mirror_post_open_month() (migration 20269000000000); this
// suite pins the handler's alert policy: which RPC outcomes raise an app_errors
// 'cron' breadcrumb for the daily digest vs. run silent.

import { describe, it, expect } from "vitest";
import { decideAlert } from "../xoro-gl-mirror-post.js";

describe("decideAlert", () => {
  it("stays silent on a clean posted run with no backlog", () => {
    const r = decideAlert({ status: "posted", month: "2026-07", posted: 42, remaining: 0, posted_revenue: 12345.67 });
    expect(r.alert).toBe(false);
  });

  it("stays silent on a no-op (nothing pending)", () => {
    const r = decideAlert({ status: "noop", month: "2026-07", posted: 0, remaining: 0 });
    expect(r.alert).toBe(false);
  });

  it("ALERTS and names the guard when the run is aborted (period_not_open)", () => {
    const r = decideAlert({ status: "aborted", month: "2026-08", guard: { reason: "period_not_open", detail: "closed" } });
    expect(r.alert).toBe(true);
    expect(r.message).toContain("ABORTED");
    expect(r.message).toContain("period_not_open");
    expect(r.message).toContain("2026-08");
  });

  it("ALERTS on stale_feed abort and surfaces staging age", () => {
    const r = decideAlert({
      status: "aborted", month: "2026-07",
      staging_age_hours: 51.2,
      guard: { reason: "stale_feed", detail: { max_synced_at: "2026-07-19T07:00:00Z", age_hours: 51.2, threshold_hours: 30 } },
    });
    expect(r.alert).toBe(true);
    expect(r.message).toContain("stale_feed");
    expect(r.message).toContain("51.2h");
  });

  it("ALERTS on unmapped_or_unbalanced abort and includes the bad-txn count", () => {
    const r = decideAlert({
      status: "aborted", month: "2026-07", candidates_total: 120,
      guard: { reason: "unmapped_or_unbalanced", bad_txn_count: 3, sample: [{ txn_id: "ABC", unmapped_legs: 1, net: 0 }] },
    });
    expect(r.alert).toBe(true);
    expect(r.message).toContain("unmapped_or_unbalanced");
    expect(r.message).toContain("bad_txns=3");
  });

  it("ALERTS when a posted run leaves a bounded-chunk backlog", () => {
    const r = decideAlert({ status: "posted", month: "2026-07", posted: 600, remaining: 40, posted_revenue: 5000 });
    expect(r.alert).toBe(true);
    expect(r.message).toContain("40");
    expect(r.message).toContain("REMAIN");
  });

  it("does NOT treat posted-with-zero-remaining as a backlog", () => {
    const r = decideAlert({ status: "posted", month: "2026-07", posted: 600, remaining: 0 });
    expect(r.alert).toBe(false);
  });

  it("ALERTS defensively when the RPC returns no summary object", () => {
    expect(decideAlert(null).alert).toBe(true);
    expect(decideAlert(undefined).alert).toBe(true);
    expect(decideAlert("nope").alert).toBe(true);
  });
});
