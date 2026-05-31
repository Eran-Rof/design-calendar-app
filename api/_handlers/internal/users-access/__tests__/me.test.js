// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readAuthUserId } from "../me.js";

const UUID = "11111111-1111-1111-1111-111111111111";

describe("users-access/me — readAuthUserId", () => {
  it("reads the lowercase X-Auth-User-Id header", () => {
    expect(readAuthUserId({ headers: { "x-auth-user-id": UUID } })).toBe(UUID);
  });
  it("reads the capitalised header", () => {
    expect(readAuthUserId({ headers: { "X-Auth-User-Id": UUID } })).toBe(UUID);
  });
  it("falls back to ?auth_user_id query", () => {
    expect(readAuthUserId({ headers: {}, query: { auth_user_id: UUID } })).toBe(UUID);
  });
  it("trims surrounding whitespace", () => {
    expect(readAuthUserId({ headers: { "x-auth-user-id": `  ${UUID}  ` } })).toBe(UUID);
  });
  it("returns null when absent or malformed (client then fail-opens)", () => {
    expect(readAuthUserId({ headers: {} })).toBeNull();
    expect(readAuthUserId({ headers: { "x-auth-user-id": "not-a-uuid" } })).toBeNull();
    expect(readAuthUserId({})).toBeNull();
  });
});
