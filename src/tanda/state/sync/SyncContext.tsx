import React, { createContext, useContext, useReducer, useEffect } from "react";
import { type SyncState, type SyncAction, initialSyncState } from "./syncTypes";
import { syncReducer } from "./syncReducer";
import { useTandaStore } from "../../store/index";

const SyncStateCtx = createContext<SyncState>(initialSyncState);
const SyncDispatchCtx = createContext<React.Dispatch<SyncAction>>(() => {});

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(syncReducer, initialSyncState);
  useEffect(() => { useTandaStore.setState(state); }, [state]);
  return (
    <SyncStateCtx.Provider value={state}>
      <SyncDispatchCtx.Provider value={dispatch}>
        {children}
      </SyncDispatchCtx.Provider>
    </SyncStateCtx.Provider>
  );
}

export function useSyncState() { return useContext(SyncStateCtx); }
export function useSyncDispatch() { return useContext(SyncDispatchCtx); }
