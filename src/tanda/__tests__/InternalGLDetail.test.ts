// Tests for InternalGLDetail deep-link parser — operator ask #15 drill-down
// from COA balance column.

import { describe, it, expect } from "vitest";
import { readDeepLink } from "../InternalGLDetail";

describe("readDeepLink", () => {
  const UUID = "11111111-2222-3333-4444-555555555555";

  it("returns empty for blank search string", () => {
    expect(readDeepLink("")).toEqual({});
  });

  it("parses full drill-down query", () => {
    const s = `?view=gl_detail&account_id=${UUID}&from=2026-01-01&to=2026-03-31`;
    expect(readDeepLink(s)).toEqual({
      account_id: UUID,
      from: "2026-01-01",
      to: "2026-03-31",
    });
  });

  it("rejects non-UUID account_id", () => {
    expect(readDeepLink("?account_id=not-a-uuid&from=2026-01-01&to=2026-03-31"))
      .toEqual({ from: "2026-01-01", to: "2026-03-31" });
  });

  it("rejects malformed dates", () => {
    expect(readDeepLink(`?account_id=${UUID}&from=01/01/2026&to=tomorrow`))
      .toEqual({ account_id: UUID });
  });

  it("ignores unrelated params", () => {
    expect(readDeepLink(`?view=gl_detail&account_id=${UUID}&foo=bar&baz=qux`))
      .toEqual({ account_id: UUID });
  });
});
