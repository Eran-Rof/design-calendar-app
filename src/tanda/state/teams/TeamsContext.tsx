import React, { createContext, useContext, useReducer, useEffect } from "react";
import { type TeamsState, type TeamsAction, initialTeamsState } from "./teamsTypes";
import { teamsReducer } from "./teamsReducer";
import { useTandaStore } from "../../store/index";

const TeamsStateCtx = createContext<TeamsState>(initialTeamsState);
const TeamsDispatchCtx = createContext<React.Dispatch<TeamsAction>>(() => {});

export function TeamsProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(teamsReducer, initialTeamsState);
  useEffect(() => { useTandaStore.setState(state); }, [state]);
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
