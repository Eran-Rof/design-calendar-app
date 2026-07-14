// P28-1-2 — pure validation/identity helpers of the assistant handlers.

import { describe, it, expect } from "vitest";
import { readAuthUserId } from "../../../_handlers/internal/assistant/today.js";
import { validateDismissBody } from "../../../_handlers/internal/assistant/dismiss.js";
import { allProviderKeys } from "../registry.js";

const UUID = "11111111-2222-3333-4444-555555555555";

describe("readAuthUserId", () => {
  it("reads a valid uuid from the header", () => {
    expect(readAuthUserId({ headers: { "x-auth-user-id": UUID } })).toBe(UUID);
  });
  it("rejects malformed ids", () => {
    expect(readAuthUserId({ headers: { "x-auth-user-id": "robert'); DROP" } })).toBeNull();
    expect(readAuthUserId({ headers: {} })).toBeNull();
    expect(readAuthUserId({})).toBeNull();
  });
  it("falls back to the query param", () => {
    expect(readAuthUserId({ headers: {}, query: { auth_user_id: UUID } })).toBe(UUID);
  });
});

describe("validateDismissBody", () => {
  const known = allProviderKeys();

  it("accepts a registered provider key", () => {
    const key = known[0];
    expect(validateDismissBody({ item_key: ` ${key} ` }, known)).toEqual({ item_key: key });
  });
  it("rejects missing / empty / unknown keys", () => {
    expect(validateDismissBody({}, known).error).toMatch(/required/);
    expect(validateDismissBody({ item_key: "  " }, known).error).toMatch(/required/);
    expect(validateDismissBody({ item_key: "nope.nothere" }, known).error).toMatch(/unknown/);
    expect(validateDismissBody({ item_key: 42 }, known).error).toMatch(/required/);
  });
});
