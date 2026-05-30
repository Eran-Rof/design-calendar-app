// @vitest-environment jsdom
//
// Render tests for <DynamicSearchInput /> — Operator ask #8 primitive.

import React, { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { DynamicSearchInput } from "../DynamicSearchInput";

describe("DynamicSearchInput — controlled mode", () => {
  it("renders the controlled value and updates synchronously via onChange", () => {
    function Host() {
      const [v, setV] = useState("");
      return (
        <DynamicSearchInput
          value={v}
          onChange={setV}
          placeholder="Search codes…"
          data-testid="dsi"
        />
      );
    }
    render(<Host />);
    const input = screen.getByTestId("dsi") as HTMLInputElement;
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "10" } });
    expect(input.value).toBe("10");
    fireEvent.change(input, { target: { value: "1000" } });
    expect(input.value).toBe("1000");
  });

  it("forwards every keystroke to onChange (no debounce in controlled mode)", () => {
    const onChange = vi.fn();
    render(
      <DynamicSearchInput value="" onChange={onChange} data-testid="dsi" />,
    );
    const input = screen.getByTestId("dsi") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.change(input, { target: { value: "ab" } });
    fireEvent.change(input, { target: { value: "abc" } });
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange).toHaveBeenNthCalledWith(1, "a");
    expect(onChange).toHaveBeenNthCalledWith(2, "ab");
    expect(onChange).toHaveBeenNthCalledWith(3, "abc");
  });

  it("uses ariaLabel when supplied; falls back to placeholder otherwise", () => {
    const { rerender } = render(
      <DynamicSearchInput
        value=""
        onChange={() => {}}
        placeholder="Search…"
        data-testid="dsi"
      />,
    );
    expect(screen.getByTestId("dsi").getAttribute("aria-label")).toBe("Search…");

    rerender(
      <DynamicSearchInput
        value=""
        onChange={() => {}}
        placeholder="Search…"
        ariaLabel="Search accounts"
        data-testid="dsi"
      />,
    );
    expect(screen.getByTestId("dsi").getAttribute("aria-label")).toBe("Search accounts");
  });

  it("shows the clear-X button only when value is non-empty and clears via click", () => {
    function Host() {
      const [v, setV] = useState("seed");
      return <DynamicSearchInput value={v} onChange={setV} data-testid="dsi" />;
    }
    render(<Host />);
    const input = screen.getByTestId("dsi") as HTMLInputElement;
    expect(input.value).toBe("seed");
    const clearBtn = screen.getByRole("button", { name: /clear search/i });
    fireEvent.click(clearBtn);
    expect(input.value).toBe("");
    expect(screen.queryByRole("button", { name: /clear search/i })).toBeNull();
  });

  it("Esc clears the input", () => {
    function Host() {
      const [v, setV] = useState("hello");
      return <DynamicSearchInput value={v} onChange={setV} data-testid="dsi" />;
    }
    render(<Host />);
    const input = screen.getByTestId("dsi") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
  });

  it("Enter is a no-op (does not submit, does not call onChange)", () => {
    const onChange = vi.fn();
    render(
      <DynamicSearchInput value="abc" onChange={onChange} data-testid="dsi" />,
    );
    const input = screen.getByTestId("dsi") as HTMLInputElement;
    const evt = fireEvent.keyDown(input, { key: "Enter" });
    // fireEvent returns false when preventDefault was called.
    expect(evt).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("DynamicSearchInput — uncontrolled mode", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("updates the input synchronously and emits debouncedChange after the delay", () => {
    const onDebounced = vi.fn();
    render(
      <DynamicSearchInput
        debounceMs={200}
        onDebouncedChange={onDebounced}
        data-testid="dsi"
      />,
    );
    const input = screen.getByTestId("dsi") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "h" } });
    fireEvent.change(input, { target: { value: "he" } });
    fireEvent.change(input, { target: { value: "hel" } });
    expect(input.value).toBe("hel");
    expect(onDebounced).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(199); });
    expect(onDebounced).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(1); });
    expect(onDebounced).toHaveBeenCalledTimes(1);
    expect(onDebounced).toHaveBeenCalledWith("hel");
  });

  it("clear via Esc fires onDebouncedChange('') immediately", () => {
    const onDebounced = vi.fn();
    render(
      <DynamicSearchInput
        debounceMs={200}
        onDebouncedChange={onDebounced}
        data-testid="dsi"
      />,
    );
    const input = screen.getByTestId("dsi") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "abc" } });
    act(() => { vi.advanceTimersByTime(200); });
    expect(onDebounced).toHaveBeenLastCalledWith("abc");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
    expect(onDebounced).toHaveBeenLastCalledWith("");
  });

  it("does not emit a spurious onDebouncedChange on mount with empty initial state", () => {
    const onDebounced = vi.fn();
    render(
      <DynamicSearchInput
        debounceMs={200}
        onDebouncedChange={onDebounced}
        data-testid="dsi"
      />,
    );
    act(() => { vi.advanceTimersByTime(500); });
    expect(onDebounced).not.toHaveBeenCalled();
  });
});
