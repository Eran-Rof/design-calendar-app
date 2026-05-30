// localStorage-backed Set<string> for the wholesale planning grid's
// hidden-column toggle. Same synchronous-write pattern as
// useCollapsePersistence — the toggle setter writes inside its
// updater, not via useEffect, so the planner's preference can't
// be dropped by an unmount mid-write.

import { useState } from "react";

const DEFAULT_STORAGE_KEY = "ws_planning_hidden_columns";

function loadHiddenColumns(storageKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

export interface HiddenColumnsApi {
  /** Current hidden-columns set. */
  hiddenColumns: Set<string>;
  /** Toggle membership for `key` — writes the resulting set to localStorage. */
  toggleColumn: (key: string) => void;
  /** Clear all hidden columns + remove the localStorage entry. */
  resetColumns: () => void;
}

/**
 * Accepts an optional storageKey so each grid that wants column-visibility
 * memory can have its own. Defaults to "ws_planning_hidden_columns" for
 * backwards compat with existing wholesale planning callers.
 */
export function usePersistedHiddenColumns(storageKey: string = DEFAULT_STORAGE_KEY): HiddenColumnsApi {
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(() => loadHiddenColumns(storageKey));

  const toggleColumn = (key: string) => {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(storageKey, JSON.stringify(Array.from(next)));
      } catch { /* ignore quota */ }
      return next;
    });
  };

  const resetColumns = () => {
    setHiddenColumns(new Set());
    try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
  };

  return { hiddenColumns, toggleColumn, resetColumns };
}
