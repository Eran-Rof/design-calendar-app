import { describe, it, expect } from "vitest";
import { matchPrepackMatrix } from "../styleMatrix.js";

// Mirrors the prod state behind PR #1451 follow-up: the Edge Slim matrix is keyed
// with an inseam infix (RYB059430PPK) but the real ordered style is the style-grain
// RYB0594PPK. matchPrepackMatrix must still resolve it.
const M = (ppk_style_code, pack_token = "PPK24", id = ppk_style_code) => ({ id, ppk_style_code, pack_token });

describe("matchPrepackMatrix", () => {
  it("exact ppk_style_code wins (case-insensitive)", () => {
    const ms = [M("RYB0594PPK"), M("RYB059430PPK")];
    expect(matchPrepackMatrix("ryb0594ppk", "PPK24", ms).ppk_style_code).toBe("RYB0594PPK");
  });

  it("resolves the inseam-infix mis-key (RYB0594PPK ↔ RYB059430PPK)", () => {
    const ms = [M("RYB059430PPK")];
    expect(matchPrepackMatrix("RYB0594PPK", "PPK24", ms)?.ppk_style_code).toBe("RYB059430PPK");
  });

  it("does NOT cross-match a sibling waist/style (RYB059431PPK ≠ RYB059430 stem)", () => {
    const ms = [M("RYB059430PPK")];
    // Order style RYB059431PPK: stem RYB059431, matrix stem RYB059430 — neither prefixes the other.
    expect(matchPrepackMatrix("RYB059431PPK", "PPK24", ms)).toBeNull();
  });

  it("ignores base-code orphans without PPK (RYB147730)", () => {
    const ms = [M("RYB147730", "PPK24")];
    expect(matchPrepackMatrix("RYB0594PPK", "PPK24", ms)).toBeNull();
  });

  it("prefers the matrix whose pack token matches the SKU token", () => {
    const ms = [M("RYB059430PPK", "PPK48"), M("RYB059432PPK", "PPK24")];
    expect(matchPrepackMatrix("RYB0594PPK", "PPK24", ms)?.ppk_style_code).toBe("RYB059432PPK");
  });

  it("among equal pack tokens, prefers the shortest inseam gap then code order", () => {
    const ms = [M("RYB0594321PPK", "PPK24"), M("RYB059430PPK", "PPK24")];
    // both share stem prefix RYB0594; gaps "321" (3) vs "30" (2) → shortest wins.
    expect(matchPrepackMatrix("RYB0594PPK", "PPK24", ms)?.ppk_style_code).toBe("RYB059430PPK");
  });

  it("returns null on empty / missing inputs", () => {
    expect(matchPrepackMatrix("RYB0594PPK", "PPK24", [])).toBeNull();
    expect(matchPrepackMatrix("RYB0594PPK", "PPK24", null)).toBeNull();
    expect(matchPrepackMatrix("", "PPK24", [M("RYB059430PPK")])).toBeNull();
  });

  it("tolerates a dash before PPK (RJO0639-PPK ↔ RJO063932-PPK)", () => {
    const ms = [M("RJO063932-PPK", "PPK18")];
    expect(matchPrepackMatrix("RJO0639-PPK", "PPK18", ms)?.ppk_style_code).toBe("RJO063932-PPK");
  });
});
