import React, { createContext, useContext, useReducer } from "react";
import { type CoreState, type CoreAction, initialCoreState } from "./coreTypes";
import { coreReducer } from "./coreReducer";

const CoreStateCtx = createContext<CoreState>(initialCoreState);
const CoreDispatchCtx = createContext<React.Dispatch<CoreAction>>(() => {});

export function CoreProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(coreReducer, initialCoreState);
  return (
    <CoreStateCtx.Provider value={state}>
      <CoreDispatchCtx.Provider value={dispatch}>
        {children}
      </CoreDispatchCtx.Provider>
    </CoreStateCtx.Provider>
  );
}

export function useCoreState() { return useContext(CoreStateCtx); }
export function useCoreDispatch() { return useContext(CoreDispatchCtx); }
