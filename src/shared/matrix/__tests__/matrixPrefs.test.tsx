// @vitest-environment jsdom
// Shared matrix view prefs — the green "hide empty sizes" default (ON) and the
// "totals only" default (OFF), plus the MatrixTotalsToggle chip that flips + persists.

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  MATRIX_HIDE_EMPTY_KEY, MATRIX_TOTALS_ONLY_KEY,
  readHideEmptySizes, readTotalsOnly,
} from "../matrixPrefs";
import { MatrixTotalsToggle } from "../MatrixTotalsToggle";

beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });

describe("matrix prefs readers", () => {
  it("hide-empty-sizes DEFAULTS ON; only an explicit 'false' turns it off", () => {
    expect(readHideEmptySizes()).toBe(true);
    localStorage.setItem(MATRIX_HIDE_EMPTY_KEY, "false");
    expect(readHideEmptySizes()).toBe(false);
    localStorage.setItem(MATRIX_HIDE_EMPTY_KEY, "true");
    expect(readHideEmptySizes()).toBe(true);
  });

  it("totals-only DEFAULTS OFF; only an explicit 'true' turns it on", () => {
    expect(readTotalsOnly()).toBe(false);
    localStorage.setItem(MATRIX_TOTALS_ONLY_KEY, "true");
    expect(readTotalsOnly()).toBe(true);
  });
});

describe("MatrixTotalsToggle", () => {
  it("flips the shared pref, persists it, and reflects state in the label", () => {
    render(<MatrixTotalsToggle />);
    const btn = screen.getByRole("button", { name: /totals only/i });
    // Starts inactive (no check glyph, pref absent).
    expect(readTotalsOnly()).toBe(false);
    fireEvent.click(btn);
    expect(readTotalsOnly()).toBe(true);
    expect(localStorage.getItem(MATRIX_TOTALS_ONLY_KEY)).toBe("true");
    fireEvent.click(btn);
    expect(readTotalsOnly()).toBe(false);
    expect(localStorage.getItem(MATRIX_TOTALS_ONLY_KEY)).toBe("false");
  });

  it("two mounted toggles stay in sync via the broadcast event", () => {
    render(<><MatrixTotalsToggle /><MatrixTotalsToggle /></>);
    const [a, b] = screen.getAllByRole("button", { name: /totals only/i });
    fireEvent.click(a);
    // Both chips now read the active (blue) state from the shared pref.
    expect(a.textContent).toContain("✓");
    expect(b.textContent).toContain("✓");
  });
});
