import React, { createContext, useContext, useReducer } from "react";
import { type ATSState, type ATSAction, createInitialState } from "./atsTypes";
import { atsReducer } from "./atsReducer";
import { fmtDate, addDays } from "../helpers";

const today = new Date();
const defaultStart = fmtDate(addDays(today, -5));

const ATSStateCtx = createContext<ATSState>(createInitialState(defaultStart));
const ATSDispatchCtx = createContext<React.Dispatch<ATSAction>>(() => {});

export function ATSProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(atsReducer, createInitialState(defaultStart));
  return (
    <ATSStateCtx.Provider value={state}>
      <ATSDispatchCtx.Provider value={dispatch}>
        {children}
      </ATSDispatchCtx.Provider>
    </ATSStateCtx.Provider>
  );
}

export function useATSState() { return useContext(ATSStateCtx); }
export function useATSDispatch() { return useContext(ATSDispatchCtx); }
