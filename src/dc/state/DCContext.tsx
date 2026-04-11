import React, { createContext, useContext, useCallback } from "react";
import { type DCState, type DCAction } from "./dcTypes";
import { useAppStore } from "../../store";

/**
 * Bridge layer: DCContext now delegates to the Zustand store instead of
 * useReducer. All existing code that reads dc.someField or dispatches
 * dcD({ type: "SET", ... }) continues to work unchanged.
 *
 * Components can gradually migrate to useAppStore directly, then this
 * bridge can be removed.
 */

const DCDispatchCtx = createContext<React.Dispatch<DCAction>>(() => {});

export function DCProvider({ children }: { children: React.ReactNode }) {
  // Bridge dispatch: translate DCAction into Zustand store mutations
  const dispatch = useCallback((action: DCAction) => {
    const store = useAppStore.getState();
    switch (action.type) {
      case "SET":
        store.setField(action.field as any, action.value);
        break;
      case "CLOSE_ALL_MODALS":
        store.closeAllModals();
        break;
      case "PUSH_UNDO":
        store.pushUndo(action.entry);
        break;
      case "POP_UNDO":
        store.popUndo();
        break;
    }
  }, []);

  return (
    <DCDispatchCtx.Provider value={dispatch}>
      {children}
    </DCDispatchCtx.Provider>
  );
}

/** Read UI state — now backed by Zustand */
export function useDCState(): DCState {
  // Subscribe to the entire Zustand store and return it as DCState.
  // Components that use this will re-render on any store change (same
  // as the old useReducer behavior). Fine for the bridge period.
  return useAppStore() as unknown as DCState;
}

export function useDCDispatch() { return useContext(DCDispatchCtx); }
