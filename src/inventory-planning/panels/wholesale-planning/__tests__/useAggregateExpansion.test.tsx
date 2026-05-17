// @vitest-environment jsdom
//
// Tests for useAggregateExpansion. The non-obvious behavior pinned
// here is the search-active interaction: when a search is active,
// every aggregate is implicitly expanded (the parent component does
// that), but the chevron click must still be able to explicitly
// collapse one. Both `expandedAggs` and `manuallyCollapsedAggs`
// have to flip together for the toggle to be the inverse of what
// the user sees.

import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAggregateExpansion } from "../hooks/useAggregateExpansion";

describe("useAggregateExpansion", () => {
  it("starts with both Sets empty", () => {
    const { result } = renderHook(() => useAggregateExpansion());
    expect(result.current.expandedAggs.size).toBe(0);
    expect(result.current.manuallyCollapsedAggs.size).toBe(0);
  });

  it("first toggle (search inactive) adds to expandedAggs, leaves manuallyCollapsed empty", () => {
    const { result } = renderHook(() => useAggregateExpansion());
    act(() => { result.current.toggleAggExpanded("agg-1", false); });
    expect(result.current.expandedAggs.has("agg-1")).toBe(true);
    expect(result.current.manuallyCollapsedAggs.has("agg-1")).toBe(false);
  });

  it("second toggle (search inactive) removes from expandedAggs", () => {
    const { result } = renderHook(() => useAggregateExpansion());
    act(() => { result.current.toggleAggExpanded("agg-1", false); });
    act(() => { result.current.toggleAggExpanded("agg-1", false); });
    expect(result.current.expandedAggs.has("agg-1")).toBe(false);
  });

  it("toggle while search-active on an auto-expanded row adds it to manuallyCollapsed", () => {
    const { result } = renderHook(() => useAggregateExpansion());
    // searchActive=true means the parent treats agg-1 as expanded
    // even though our Set is empty. Toggle should collapse it.
    act(() => { result.current.toggleAggExpanded("agg-1", true); });
    expect(result.current.manuallyCollapsedAggs.has("agg-1")).toBe(true);
    expect(result.current.expandedAggs.has("agg-1")).toBe(false);
  });

  it("toggle a manually-collapsed-during-search row re-expands it", () => {
    const { result } = renderHook(() => useAggregateExpansion());
    // First: collapse it while search-active
    act(() => { result.current.toggleAggExpanded("agg-1", true); });
    expect(result.current.manuallyCollapsedAggs.has("agg-1")).toBe(true);

    // Second: toggle again while search-active
    act(() => { result.current.toggleAggExpanded("agg-1", true); });
    // wasExpanded was false (in manuallyCollapsed), so toggle now expands
    expect(result.current.expandedAggs.has("agg-1")).toBe(true);
    expect(result.current.manuallyCollapsedAggs.has("agg-1")).toBe(false);
  });

  it("toggles for different forecastIds are independent", () => {
    const { result } = renderHook(() => useAggregateExpansion());
    act(() => { result.current.toggleAggExpanded("agg-1", false); });
    act(() => { result.current.toggleAggExpanded("agg-2", false); });
    expect(result.current.expandedAggs.has("agg-1")).toBe(true);
    expect(result.current.expandedAggs.has("agg-2")).toBe(true);
    act(() => { result.current.toggleAggExpanded("agg-1", false); });
    expect(result.current.expandedAggs.has("agg-1")).toBe(false);
    expect(result.current.expandedAggs.has("agg-2")).toBe(true);
  });

  it("toggle on a never-touched row while search active correctly collapses", () => {
    const { result } = renderHook(() => useAggregateExpansion());
    // Same as the "search-active on auto-expanded" case but
    // explicit: the user has never touched this aggregate; under
    // an active search it's auto-expanded; chevron click should
    // mark it manually collapsed.
    act(() => { result.current.toggleAggExpanded("never-touched", true); });
    expect(result.current.manuallyCollapsedAggs.has("never-touched")).toBe(true);
  });
});
