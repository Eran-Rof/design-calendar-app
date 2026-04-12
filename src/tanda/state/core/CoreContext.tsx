import React, { createContext, useContext, useReducer, useEffect } from "react";
import { type CoreState, type CoreAction, initialCoreState } from "./coreTypes";
import { coreReducer } from "./coreReducer";
import { useTandaStore } from "../../store/index";

const CoreStateCtx = createContext<CoreState>(initialCoreState);
const CoreDispatchCtx = createContext<React.Dispatch<CoreAction>>(() => {});

export function CoreProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(coreReducer, initialCoreState);
  useEffect(() => { useTandaStore.setState(state); }, [state]);
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
