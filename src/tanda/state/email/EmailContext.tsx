import React, { createContext, useContext, useReducer, useEffect } from "react";
import { type EmailState, type EmailAction, initialEmailState } from "./emailTypes";
import { emailReducer } from "./emailReducer";
import { useTandaStore } from "../../store/index";

const EmailStateCtx = createContext<EmailState>(initialEmailState);
const EmailDispatchCtx = createContext<React.Dispatch<EmailAction>>(() => {});

export function EmailProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(emailReducer, initialEmailState);
  useEffect(() => { useTandaStore.setState(state); }, [state]);
  return (
    <EmailStateCtx.Provider value={state}>
      <EmailDispatchCtx.Provider value={dispatch}>
        {children}
      </EmailDispatchCtx.Provider>
    </EmailStateCtx.Provider>
  );
}

export function useEmailState() { return useContext(EmailStateCtx); }
export function useEmailDispatch() { return useContext(EmailDispatchCtx); }
