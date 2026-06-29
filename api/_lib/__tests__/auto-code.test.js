// Tests for Chunk M auto-code generator (operator item 14).

import { describe, it, expect, vi } from "vitest";
import { nextCode, insertWithAutoCode } from "../autoCode.js";

// Build a mock supabase client whose .from(...).select(...).ilike(...).eq(...)
// chain resolves to a fixed { data: rows }. nextCode now takes MAX(numeric
// suffix)+1 over the returned rows (gap-proof), so the mock returns the existing
// code rows rather than a count.
function mockRowsClient(rows) {
  const chain = {
    select: vi.fn(() => chain),
    ilike: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    then: (resolve) => resolve({ data: rows }),
  };
  return { from: vi.fn(() => chain) };
}
const codes = (...nums) => nums.map((n) => ({ code: n }));

describe("nextCode", () => {
  it("returns prefix-00001 when there are no existing rows", async () => {
    const admin = mockRowsClient([]);
    expect(await nextCode(admin, "customers", "code", "CUST-")).toBe("CUST-00001");
  });
  it("increments from the existing MAX suffix", async () => {
    const admin = mockRowsClient(codes("VEND-00041", "VEND-00010"));
    expect(await nextCode(admin, "vendors", "code", "VEND-")).toBe("VEND-00042");
  });
  it("is gap-proof — uses MAX, not COUNT (the bug fix)", async () => {
    // 2 rows but numbered up to 00005 → next must be 00006, NOT 00003.
    const admin = mockRowsClient(codes("CUST-00001", "CUST-00005"));
    expect(await nextCode(admin, "customers", "code", "CUST-")).toBe("CUST-00006");
  });
  it("treats null/empty data as zero", async () => {
    const admin = mockRowsClient(null);
    expect(await nextCode(admin, "employees", "code", "EMP-")).toBe("EMP-00001");
  });
  it("applies the bump offset (used by the retry)", async () => {
    const admin = mockRowsClient(codes("FAB-00005"));
    expect(await nextCode(admin, "fabric_codes", "code", "FAB-", { bump: 2 })).toBe("FAB-00008");
  });
  it("scopes the query to entity_id when provided", async () => {
    const chain = {
      select: vi.fn(() => chain),
      ilike: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      then: (resolve) => resolve({ data: codes("FCT-00003") }),
    };
    const admin = { from: vi.fn(() => chain) };
    const code = await nextCode(admin, "factor_master", "code", "FCT-", { entityId: "e1" });
    expect(code).toBe("FCT-00004");
    expect(chain.eq).toHaveBeenCalledWith("entity_id", "e1");
  });
});

describe("insertWithAutoCode", () => {
  // Helper: client whose nextCode query returns `rows`, and whose insert resolves
  // to a queued sequence of { error } / { data } results (one per attempt).
  function mockInsertClient(rows, insertResults) {
    let attempt = 0;
    const insertChain = {
      select: vi.fn(() => insertChain),
      single: vi.fn(() => Promise.resolve(insertResults[attempt++])),
    };
    const rowsChain = {
      select: vi.fn(() => rowsChain),
      ilike: vi.fn(() => rowsChain),
      eq: vi.fn(() => rowsChain),
      then: (resolve) => resolve({ data: rows }),
    };
    return {
      from: vi.fn(() => ({
        select: rowsChain.select,
        ilike: rowsChain.ilike,
        eq: rowsChain.eq,
        then: rowsChain.then,
        insert: vi.fn(() => insertChain),
      })),
    };
  }

  it("inserts with the generated code on the first try", async () => {
    const admin = mockInsertClient([], [{ data: { id: "x", code: "CUST-00001" } }]);
    const built = [];
    const { data, error } = await insertWithAutoCode(
      admin, "customers", "code", "CUST-",
      (code) => { built.push(code); return { code, name: "Acme" }; },
    );
    expect(error).toBeUndefined();
    expect(data.code).toBe("CUST-00001");
    expect(built[0]).toBe("CUST-00001");
  });

  it("retries on a 23505 collision, bumping the number", async () => {
    const admin = mockInsertClient([], [
      { error: { code: "23505" } },
      { data: { id: "y", code: "CUST-00002" } },
    ]);
    const built = [];
    const { data, error } = await insertWithAutoCode(
      admin, "customers", "code", "CUST-",
      (code) => { built.push(code); return { code }; },
    );
    expect(error).toBeUndefined();
    expect(data.code).toBe("CUST-00002");
    // First attempt builds 00001 (bump 0), retry builds 00002 (bump 1).
    expect(built).toEqual(["CUST-00001", "CUST-00002"]);
  });

  it("returns a non-23505 error immediately without retrying", async () => {
    const admin = mockInsertClient([], [
      { error: { code: "23502", message: "null value" } },
      { data: { id: "z" } },
    ]);
    const built = [];
    const { error } = await insertWithAutoCode(
      admin, "customers", "code", "CUST-",
      (code) => { built.push(code); return { code }; },
    );
    expect(error.code).toBe("23502");
    expect(built).toHaveLength(1);
  });
});
