// localStorage-backed `[collapse, setCollapse]` pair for the wholesale
// planning grid's collapse-mode toggles. Persists synchronously
// inside the setter (not via useEffect) so a subsequent unmount
// — tab switch, run change, refresh during a save — can't drop the
// write the way a deferred effect could.
//
// `dev-debug` log lines preserved verbatim so the existing
// `[ip-debug loadCollapse]` / `[ip-debug writeCollapse]` console
// traces planners + ops have been using stay intact.

import { useState } from "react";
import type { CollapseModes } from "../types";

const STORAGE_KEY = "ws_planning_collapse";

const EMPTY: CollapseModes = {
  customers: false,
  colors: false,
  category: false,
  subCat: false,
  customerAllStyles: false,
  allCustomersPerCategory: false,
  allCustomersPerSubCat: false,
  allCustomersPerStyle: false,
};

function loadCollapse(): CollapseModes {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log("[ip-debug loadCollapse] raw=", raw);
    }
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return {
        customers: !!parsed.customers,
        colors: !!parsed.colors,
        category: !!parsed.category,
        subCat: !!parsed.subCat,
        customerAllStyles: !!parsed.customerAllStyles,
        allCustomersPerCategory: !!parsed.allCustomersPerCategory,
        allCustomersPerSubCat: !!parsed.allCustomersPerSubCat,
        allCustomersPerStyle: !!parsed.allCustomersPerStyle,
      };
    }
  } catch { /* ignore parse / quota errors — fall through to empty */ }
  return { ...EMPTY };
}

/**
 * Hook returning a `[collapse, setCollapse]` pair where every state
 * write is mirrored to `localStorage.ws_planning_collapse` inside
 * the setter (synchronous write).
 *
 * `setCollapse` accepts either a value or an updater function, just
 * like the underlying `useState` setter.
 */
export function useCollapsePersistence(): [
  CollapseModes,
  (next: CollapseModes | ((cur: CollapseModes) => CollapseModes)) => void,
] {
  const [collapse, setCollapseRaw] = useState<CollapseModes>(loadCollapse);

  const setCollapse: (next: CollapseModes | ((cur: CollapseModes) => CollapseModes)) => void = (next) => {
    setCollapseRaw((cur) => {
      const computed = typeof next === "function"
        ? (next as (c: CollapseModes) => CollapseModes)(cur)
        : next;
      try {
        const json = JSON.stringify(computed);
        localStorage.setItem(STORAGE_KEY, json);
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.log("[ip-debug writeCollapse] ←", json);
        }
      } catch { /* ignore quota */ }
      return computed;
    });
  };

  return [collapse, setCollapse];
}
