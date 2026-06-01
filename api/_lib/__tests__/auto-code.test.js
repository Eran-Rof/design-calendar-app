// Tests for Chunk M auto-code generator (operator item 14).

import { describe, it, expect, vi } from "vitest";
import { nextCode, insertWithAutoCode } from "../autoCode.js";

// Build a mock supabase client whose .from(...).select(...).ilike(...).eq(...)
// chain resolves to a fixed { count }. The chain is thenable at the end via the
// terminal .ilike()/.eq() returning a promise-like with the count.
function mockCountClient(count) {
  const chain = {
    select: vi.fn(() => chain),
    ilike: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    then: (resolve) => resolve({ count }),
  };
  return { from: vi.fn(() => chain) };
}

describe("nextCode", () => {
  it("returns prefix + zero-padded count+1", async () => {
    const admin = mockCountClient(0);
    expect(await nextCode(admin, "customers", "code", "CUST-")).toBe("CUST-00001");
  });
  it("increments from an existing count", async () => {
    const admin = mockCountClient(41);
    expect(await nextCode(admin, "vendors", "code", "VEND-")).toBe("VEND-00042");
  });
  it("treats a null count as zero", async () => {
    const admin = mockCountClient(null);
    expect(await nextCode(admin, "employees", "code", "EMP-")).toBe("EMP-00001");
  });
  it("applies the bump offset (used by the retry)", async () => {
    const admin = mockCountClient(5);
    expect(await nextCode(admin, "fabric_codes", "code", "FAB-", { bump: 2 })).toBe("FAB-00008");
  });
  it("scopes the count to entity_id when provided", async () => {
    const chain = {
      select: vi.fn(() => chain),
      ilike: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      then: (resolve) => resolve({ count: 3 }),
    };
    const admin = { from: vi.fn(() => chain) };
    const code = await nextCode(admin, "factor_master", "code", "FCT-", { entityId: "e1" });
    expect(code).toBe("FCT-00004");
    expect(chain.eq).toHaveBeenCalledWith("entity_id", "e1");
  });
});

describe("insertWithAutoCode", () => {
  // Helper: client that counts `count` rows and whose insert resolves to a
  // queued sequence of { error } / { data } results (one per attempt).
  function mockInsertClient(count, insertResults) {
    let attempt = 0;
    const insertChain = {
      select: vi.fn(() => insertChain),
      single: vi.fn(() => Promise.resolve(insertResults[attempt++])),
    };
    const countChain = {
      select: vi.fn(() => countChain),
      ilike: vi.fn(() => countChain),
      eq: vi.fn(() => countChain),
      then: (resolve) => resolve({ count }),
    };
    return {
      _builtCodes: [],
      from: vi.fn(() => ({
        select: countChain.select,
        ilike: countChain.ilike,
        eq: countChain.eq,
        then: countChain.then,
        insert: vi.fn(() => insertChain),
      })),
    };
  }

  it("inserts with the generated code on the first try", async () => {
    const admin = mockInsertClient(0, [{ data: { id: "x", code: "CUST-00001" } }]);
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
    const admin = mockInsertClient(0, [
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
    const admin = mockInsertClient(0, [
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
