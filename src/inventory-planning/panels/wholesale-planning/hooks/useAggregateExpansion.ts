// Tracks which aggregate rows the planner has expanded (parent ⇒ children
// visible inline) and which they've EXPLICITLY collapsed despite an
// auto-expand trigger.
//
// Why two Sets:
//   The grid auto-expands every aggregate while a search is active (so
//   children matching the query show up under their parent). Without a
//   manual-collapse Set, the chevron click on an auto-expanded
//   aggregate was a no-op — effectiveExpanded re-added it on the next
//   render. `manuallyCollapsedAggs` records the explicit close so the
//   auto-expand layer respects it.
//
// `toggleAggExpanded` resolves the row's *currently-visible* expansion
// state by inspecting both Sets + the searchActive flag, then flips it.

import { useState } from "react";

export interface AggregateExpansionApi {
  expandedAggs: Set<string>;
  manuallyCollapsedAggs: Set<string>;
  /**
   * Flip the visible expansion state of `forecastId`. `searchActive`
   * comes in fresh per call so the hook doesn't have to track search
   * state itself — caller passes `search.trim().length > 0`.
   */
  toggleAggExpanded: (forecastId: string, searchActive: boolean) => void;
}

export function useAggregateExpansion(): AggregateExpansionApi {
  const [expandedAggs, setExpandedAggs] = useState<Set<string>>(new Set());
  const [manuallyCollapsedAggs, setManuallyCollapsedAggs] = useState<Set<string>>(new Set());

  const toggleAggExpanded = (forecastId: string, searchActive: boolean) => {
    // Resolve the row's effective expansion at click time so toggling
    // means "do the opposite of what the user sees right now".
    const wasExpanded = expandedAggs.has(forecastId)
      || (searchActive && !manuallyCollapsedAggs.has(forecastId));

    setExpandedAggs((prev) => {
      const next = new Set(prev);
      next.delete(forecastId);
      if (!wasExpanded) next.add(forecastId);
      return next;
    });
    setManuallyCollapsedAggs((prev) => {
      const next = new Set(prev);
      if (wasExpanded) next.add(forecastId);
      else next.delete(forecastId);
      return next;
    });
  };

  return { expandedAggs, manuallyCollapsedAggs, toggleAggExpanded };
}
