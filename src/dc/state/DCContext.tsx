import React, { createContext, useContext, useReducer } from "react";
import { type DCState, type DCAction, initialDCState } from "./dcTypes";
import { dcReducer } from "./dcReducer";

const DCStateCtx = createContext<DCState>(initialDCState);
const DCDispatchCtx = createContext<React.Dispatch<DCAction>>(() => {});

export function DCProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(dcReducer, initialDCState);
  return (
    <DCStateCtx.Provider value={state}>
      <DCDispatchCtx.Provider value={dispatch}>
        {children}
      </DCDispatchCtx.Provider>
    </DCStateCtx.Provider>
  );
}

export function useDCState() { return useContext(DCStateCtx); }
export function useDCDispatch() { return useContext(DCDispatchCtx); }
