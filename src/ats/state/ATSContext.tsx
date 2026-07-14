import React, { createContext, useContext, useReducer } from "react";
import { type ATSState, type ATSAction, createInitialState } from "./atsTypes";
import { atsReducer } from "./atsReducer";
import { fmtDate, addDays } from "../helpers";

const today = new Date();
const defaultStart = fmtDate(addDays(today, -5));

// Deep-link prefill: read `?style=<code>` from the URL once on load so a caller
// (e.g. the Inventory Matrix "ATS" link) can open ATS focused on a style. The
// value seeds the free-text search box, which matches on row SKU (style-coded).
function initialSearchFromUrl(): string {
  if (typeof window === "undefined") return "";
  try {
    return (new URLSearchParams(window.location.search).get("style") || "").trim();
  } catch {
    return "";
  }
}

const ATSStateCtx = createContext<ATSState>(createInitialState(defaultStart));
const ATSDispatchCtx = createContext<React.Dispatch<ATSAction>>(() => {});

export function ATSProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(
    atsReducer,
    undefined,
    () => createInitialState(defaultStart, initialSearchFromUrl()),
  );
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
