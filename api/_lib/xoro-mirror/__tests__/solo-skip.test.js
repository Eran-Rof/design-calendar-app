// Tangerine P9-9 — tests for the T10 mirror solo-skip integration.
//
// Covers:
//   - isDomainSolo pure helper (DB shape parsing + defensive default)
//   - makeSoloSkippedSummary shape
//   - Each mirror module (ap.js, ar.js, summary-je.js) actually short-
//     circuits when the entity has solo status for the target domain.

import { describe, it, expect, vi } from "vitest";
import { isDomainSolo, makeSoloSkippedSummary } from "../solo-skip.js";
import { mirrorApForDate } from "../ap.js";
import { mirrorArForDate } from "../ar.js";
import { postDailySummaryJes } from "../summary-je.js";

const ENTITY = "00000000-0000-0000-0000-0000000000aa";

// ────────────────────────────────────────────────────────────────────────
// In-memory supabase double for the entities table only. Each mirror
// module reads parallel_run_status via .from('entities').select(...).eq('id', ...).maybeSingle().
// ────────────────────────────────────────────────────────────────────────
function makeEntityClient({ parallel_run_status = {}, error = null } = {}) {
  return {
    from(table) {
      const builder = {
        select() { return builder; },
        eq() { return builder; },
        maybeSingle() {
          if (error) return Promise.resolve({ data: null, error });
          if (table === "entities") {
            return Promise.resolve({ data: { id: ENTITY, parallel_run_status }, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        gte() { return builder; },
        lte() { return builder; },
        lt() { return builder; },
        in() { return builder; },
        order() { return builder; },
        limit() { return builder; },
        contains() { return builder; },
        update() { return { eq: () => Promise.resolve({ error: null }) }; },
        insert() { return builder; },
        // make any unanticipated chain resolve empty-ok so the mirror's
        // own bail-out paths run if isDomainSolo returns false.
        then(resolve) { return resolve({ data: [], error: null }); },
      };
      return builder;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
describe("isDomainSolo", () => {
  it("returns true when parallel_run_status[domain].status === 'solo'", async () => {
    const admin = makeEntityClient({
      parallel_run_status: { ap: { status: "solo" } },
    });
    expect(await isDomainSolo(admin, ENTITY, "ap")).toBe(true);
  });

  it("returns false when status is 'parallel'", async () => {
    const admin = makeEntityClient({
      parallel_run_status: { ap: { status: "parallel" } },
    });
    expect(await isDomainSolo(admin, ENTITY, "ap")).toBe(false);
  });

  it("returns false when domain entry is missing", async () => {
    const admin = makeEntityClient({
      parallel_run_status: { ar: { status: "solo" } },
    });
    expect(await isDomainSolo(admin, ENTITY, "ap")).toBe(false);
  });

  it("returns false when parallel_run_status is empty object", async () => {
    const admin = makeEntityClient({ parallel_run_status: {} });
    expect(await isDomainSolo(admin, ENTITY, "ap")).toBe(false);
  });

  it("returns false on DB error (don't skip on transient errors)", async () => {
    const admin = makeEntityClient({ error: { message: "kaboom" } });
    expect(await isDomainSolo(admin, ENTITY, "ap")).toBe(false);
  });

  it("returns false on bad inputs", async () => {
    expect(await isDomainSolo(null, ENTITY, "ap")).toBe(false);
    expect(await isDomainSolo({}, ENTITY, "ap")).toBe(false);
    const admin = makeEntityClient({ parallel_run_status: { ap: { status: "solo" } } });
    expect(await isDomainSolo(admin, null, "ap")).toBe(false);
    expect(await isDomainSolo(admin, ENTITY, null)).toBe(false);
  });

  it("returns false when parallel_run_status is null", async () => {
    const admin = makeEntityClient({ parallel_run_status: null });
    expect(await isDomainSolo(admin, ENTITY, "ap")).toBe(false);
  });

  it("returns false when parallel_run_status[domain] is a primitive", async () => {
    const admin = makeEntityClient({
      parallel_run_status: { ap: "solo" },
    });
    expect(await isDomainSolo(admin, ENTITY, "ap")).toBe(false);
  });

  it("returns false on thrown error", async () => {
    const admin = {
      from() { throw new Error("nope"); },
    };
    expect(await isDomainSolo(admin, ENTITY, "ap")).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
describe("makeSoloSkippedSummary", () => {
  it("returns the canonical skip shape", () => {
    const s = makeSoloSkippedSummary("ap");
    expect(s).toEqual({
      rows_upserted: 0,
      rows_unchanged: 0,
      rows_skipped_manual_conflict: 0,
      rows_skipped_solo: 0,
      skipped_solo: true,
      solo_domain: "ap",
      errors: [],
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// mirrorApForDate — solo skip
// ────────────────────────────────────────────────────────────────────────
describe("mirrorApForDate solo skip", () => {
  it("returns skipped_solo summary when AP is in solo status", async () => {
    const admin = makeEntityClient({
      parallel_run_status: { ap: { status: "solo" } },
    });
    const out = await mirrorApForDate(admin, ENTITY, "2026-05-29");
    expect(out.skipped_solo).toBe(true);
    expect(out.solo_domain).toBe("ap");
    expect(out.rows_upserted).toBe(0);
    expect(out.errors).toEqual([]);
  });

  it("does NOT skip when AP is in parallel status", async () => {
    // The entity is in parallel mode → isDomainSolo=false; the mirror
    // module then attempts to read tanda_pos, which our double returns
    // empty for (no rows). The summary should have skipped_solo undefined
    // / no solo branch.
    const admin = makeEntityClient({
      parallel_run_status: { ap: { status: "parallel" } },
    });
    const out = await mirrorApForDate(admin, ENTITY, "2026-05-29");
    expect(out.skipped_solo).toBeUndefined();
  });

  it("does NOT skip when AR is solo but AP is missing (cross-domain isolation)", async () => {
    const admin = makeEntityClient({
      parallel_run_status: { ar: { status: "solo" } },
    });
    const out = await mirrorApForDate(admin, ENTITY, "2026-05-29");
    expect(out.skipped_solo).toBeUndefined();
  });

  it("does NOT skip on bad mirror_date — validation runs first", async () => {
    const admin = makeEntityClient({
      parallel_run_status: { ap: { status: "solo" } },
    });
    const out = await mirrorApForDate(admin, ENTITY, "not-a-date");
    // bad-date error is returned before solo check
    expect(out.errors.length).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────────────────
// mirrorArForDate — solo skip
// ────────────────────────────────────────────────────────────────────────
describe("mirrorArForDate solo skip", () => {
  it("returns skipped_solo summary when AR is in solo status", async () => {
    const admin = makeEntityClient({
      parallel_run_status: { ar: { status: "solo" } },
    });
    const out = await mirrorArForDate(admin, ENTITY, "2026-05-29");
    expect(out.skipped_solo).toBe(true);
    expect(out.solo_domain).toBe("ar");
  });

  it("does NOT skip when AR is parallel", async () => {
    const admin = makeEntityClient({
      parallel_run_status: { ar: { status: "parallel" } },
    });
    const out = await mirrorArForDate(admin, ENTITY, "2026-05-29");
    expect(out.skipped_solo).toBeUndefined();
  });

  it("does NOT skip when AP is solo but AR is missing", async () => {
    const admin = makeEntityClient({
      parallel_run_status: { ap: { status: "solo" } },
    });
    const out = await mirrorArForDate(admin, ENTITY, "2026-05-29");
    expect(out.skipped_solo).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────
// postDailySummaryJes — per-domain solo skip
// ────────────────────────────────────────────────────────────────────────
describe("postDailySummaryJes per-domain solo skip", () => {
  it("AR domain: solo skip lands in result.skipped[]", async () => {
    const admin = makeEntityClient({
      parallel_run_status: { ar: { status: "solo" } },
    });
    const out = await postDailySummaryJes(admin, ENTITY, "2026-05-29");
    const arSkip = out.skipped.find((s) => s.domain === "ar");
    expect(arSkip?.reason).toBe("solo_cutover");
  });

  it("AP domain: solo skip lands in result.skipped[]", async () => {
    const admin = makeEntityClient({
      parallel_run_status: { ap: { status: "solo" } },
    });
    const out = await postDailySummaryJes(admin, ENTITY, "2026-05-29");
    const apSkip = out.skipped.find((s) => s.domain === "ap");
    expect(apSkip?.reason).toBe("solo_cutover");
  });

  it("inventory domain: solo skip lands in result.skipped[]", async () => {
    const admin = makeEntityClient({
      parallel_run_status: { inventory: { status: "solo" } },
    });
    const out = await postDailySummaryJes(admin, ENTITY, "2026-05-29");
    const invSkip = out.skipped.find((s) => s.domain === "inventory");
    expect(invSkip?.reason).toBe("solo_cutover");
  });

  it("all three domains solo → all skipped, no JE attempts", async () => {
    const admin = makeEntityClient({
      parallel_run_status: {
        ar: { status: "solo" },
        ap: { status: "solo" },
        inventory: { status: "solo" },
      },
    });
    const out = await postDailySummaryJes(admin, ENTITY, "2026-05-29");
    const reasons = out.skipped.filter((s) => s.reason === "solo_cutover").map((s) => s.domain).sort();
    expect(reasons).toEqual(["ap", "ar", "inventory"]);
    expect(out.je_ids.ar).toBeNull();
    expect(out.je_ids.ap).toBeNull();
    expect(out.je_ids.inventory_or_null).toBeNull();
  });
});
