// @vitest-environment jsdom
//
// Cross-cutter T4-4 — Unit tests for AutoLandingToast component.
//
// The toast is a "dumb" presentational component that subscribes to the
// hook's `redirecting` state via props. Logic under test:
//   • Renders nothing initially (redirecting=false)
//   • Renders message when redirecting=true with a redirectLabel
//   • Fades opacity ~200ms before the duration ends
//   • Unmounts after the duration
//   • Renders nothing if redirectLabel is missing even when redirecting=true

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";

import AutoLandingToast from "../../components/AutoLandingToast";

const NOT_REDIRECTING = {
  redirecting: false,
  redirectTarget: null,
  redirectLabel: null,
};

const REDIRECTING_TO_JE = {
  redirecting: true,
  redirectTarget: "/tanda?view=journal_entries",
  redirectLabel: "Journal Entries",
};

describe("AutoLandingToast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when redirecting=false", () => {
    render(<AutoLandingToast landing={NOT_REDIRECTING} />);
    expect(screen.queryByTestId("auto-landing-toast")).toBeNull();
  });

  it("renders the welcome-back message when redirecting=true", () => {
    render(<AutoLandingToast landing={REDIRECTING_TO_JE} durationMs={2000} />);
    const toast = screen.getByTestId("auto-landing-toast");
    expect(toast).toBeInTheDocument();
    expect(toast.textContent).toContain("Welcome back");
    expect(toast.textContent).toContain("Journal Entries");
  });

  it("starts fading ~200ms before the duration ends", () => {
    render(<AutoLandingToast landing={REDIRECTING_TO_JE} durationMs={2000} />);
    const toast = screen.getByTestId("auto-landing-toast");
    expect(toast.style.opacity).toBe("1");

    // Just before fade-at (2000 - 200 = 1800ms): still opaque.
    act(() => { vi.advanceTimersByTime(1799); });
    expect(toast.style.opacity).toBe("1");

    // After fade-at: opacity flips to 0.
    act(() => { vi.advanceTimersByTime(2); });
    expect(toast.style.opacity).toBe("0");
  });

  it("unmounts the toast after the duration elapses", () => {
    render(<AutoLandingToast landing={REDIRECTING_TO_JE} durationMs={2000} />);
    expect(screen.getByTestId("auto-landing-toast")).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(2001); });

    expect(screen.queryByTestId("auto-landing-toast")).toBeNull();
  });

  it("renders nothing when redirectLabel is missing even if redirecting=true", () => {
    render(
      <AutoLandingToast
        landing={{
          redirecting: true,
          redirectTarget: "/tanda?view=journal_entries",
          redirectLabel: null,
        }}
      />
    );
    expect(screen.queryByTestId("auto-landing-toast")).toBeNull();
  });

  it("respects a smaller custom duration", () => {
    render(<AutoLandingToast landing={REDIRECTING_TO_JE} durationMs={500} />);
    expect(screen.getByTestId("auto-landing-toast")).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(501); });
    expect(screen.queryByTestId("auto-landing-toast")).toBeNull();
  });
});
