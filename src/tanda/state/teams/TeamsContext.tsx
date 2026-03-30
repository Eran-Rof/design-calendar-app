import React, { createContext, useContext, useReducer } from "react";
import { type TeamsState, type TeamsAction, initialTeamsState } from "./teamsTypes";
import { teamsReducer } from "./teamsReducer";

const TeamsStateCtx = createContext<TeamsState>(initialTeamsState);
const TeamsDispatchCtx = createContext<React.Dispatch<TeamsAction>>(() => {});

export function TeamsProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(teamsReducer, initialTeamsState);
  return (
    <TeamsStateCtx.Provider value={state}>
      <TeamsDispatchCtx.Provider value={dispatch}>
        {children}
      </TeamsDispatchCtx.Provider>
    </TeamsStateCtx.Provider>
  );
}

export function useTeamsState() { return useContext(TeamsStateCtx); }
export function useTeamsDispatch() { return useContext(TeamsDispatchCtx); }
