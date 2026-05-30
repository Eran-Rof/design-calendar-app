// @vitest-environment jsdom
//
// Unit tests for useDebouncedSearch — Operator ask #8 primitive.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { useDebouncedSearch } from "../useDebouncedSearch";

type Probe = {
  value: string;
  debouncedValue: string;
  setValue: (next: string | ((prev: string) => string)) => void;
  clear: () => void;
};

function ProbeHost(props: {
  initial?: string;
  delay?: number;
  capture: (probe: Probe) => void;
}) {
  const { value, debouncedValue, setValue, clear } = useDebouncedSearch(
    props.initial,
    props.delay,
  );
  props.capture({ value, debouncedValue, setValue, clear });
  return <span data-testid="probe">{value}|{debouncedValue}</span>;
}

function mount(initial?: string, delay?: number) {
  let latest: Probe = {
    value: "",
    debouncedValue: "",
    setValue: () => {},
    clear: () => {},
  };
  const utils = render(
    <ProbeHost initial={initial} delay={delay} capture={(p) => { latest = p; }} />,
  );
  return {
    ...utils,
    get probe() { return latest; },
  };
}

describe("useDebouncedSearch", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("initializes value + debouncedValue to the initial argument (default '')", () => {
    const a = mount();
    expect(a.probe.value).toBe("");
    expect(a.probe.debouncedValue).toBe("");

    const b = mount("abc");
    expect(b.probe.value).toBe("abc");
    expect(b.probe.debouncedValue).toBe("abc");
  });

  it("updates value synchronously on setValue", () => {
    const h = mount();
    act(() => { h.probe.setValue("x"); });
    expect(h.probe.value).toBe("x");
    // debounce window hasn't elapsed yet
    expect(h.probe.debouncedValue).toBe("");
  });

  it("debouncedValue lands after `delay` ms of no further changes", () => {
    const h = mount("", 200);
    act(() => { h.probe.setValue("hello"); });
    expect(h.probe.debouncedValue).toBe("");

    act(() => { vi.advanceTimersByTime(199); });
    expect(h.probe.debouncedValue).toBe("");

    act(() => { vi.advanceTimersByTime(1); });
    expect(h.probe.debouncedValue).toBe("hello");
  });

  it("rapid successive setValue calls reset the timer (only final lands)", () => {
    const h = mount("", 200);
    act(() => { h.probe.setValue("a"); });
    act(() => { vi.advanceTimersByTime(150); });
    act(() => { h.probe.setValue("ab"); });
    act(() => { vi.advanceTimersByTime(150); });
    act(() => { h.probe.setValue("abc"); });

    // Total elapsed 300ms but we kept poking inside the window.
    expect(h.probe.debouncedValue).toBe("");

    act(() => { vi.advanceTimersByTime(200); });
    expect(h.probe.debouncedValue).toBe("abc");
    expect(h.probe.value).toBe("abc");
  });

  it("clear() zeroes both value and debouncedValue immediately", () => {
    const h = mount("seed", 200);
    act(() => { h.probe.setValue("changed"); });
    act(() => { vi.advanceTimersByTime(200); });
    expect(h.probe.debouncedValue).toBe("changed");

    act(() => { h.probe.clear(); });
    expect(h.probe.value).toBe("");
    expect(h.probe.debouncedValue).toBe("");
  });

  it("clear() also cancels a pending debounce timer", () => {
    const h = mount("", 200);
    act(() => { h.probe.setValue("typing"); });
    act(() => { vi.advanceTimersByTime(100); });
    act(() => { h.probe.clear(); });
    // Wait past the original window — debouncedValue must stay cleared.
    act(() => { vi.advanceTimersByTime(500); });
    expect(h.probe.value).toBe("");
    expect(h.probe.debouncedValue).toBe("");
  });

  it("setValue accepts an updater function", () => {
    const h = mount("a", 200);
    act(() => { h.probe.setValue((prev) => prev + "b"); });
    expect(h.probe.value).toBe("ab");
    act(() => { vi.advanceTimersByTime(200); });
    expect(h.probe.debouncedValue).toBe("ab");
  });

  it("custom delay is honoured", () => {
    const h = mount("", 50);
    act(() => { h.probe.setValue("fast"); });
    act(() => { vi.advanceTimersByTime(49); });
    expect(h.probe.debouncedValue).toBe("");
    act(() => { vi.advanceTimersByTime(1); });
    expect(h.probe.debouncedValue).toBe("fast");
  });

  it("does not schedule a redundant debounce when value already matches", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const h = mount("same", 200);
    setTimeoutSpy.mockClear();
    act(() => { h.probe.setValue("same"); });
    // The setValue triggered a re-render but value === debouncedValue, so the
    // effect's early-return should prevent scheduling another timer.
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });
});
