// localStorage-mirrored useState pair. The wholesale planning grid
// has 10+ filter slots that all share the same shape:
//   const [x, setX] = useState(() => loadFilter(key));
//   useEffect(() => save(key, x), [x]);
//
// usePersistedStringArray packages the state + the load + the
// save effect into one hook so adding a new persisted filter is a
// one-liner. usePersistedString is the same for plain strings.
//
// All entries are namespaced ws_planning_filter_<key> for back-compat
// with the existing persisted values (planners shouldn't lose their
// saved scope on upgrade).

import { useEffect, useState } from "react";

const KEY_PREFIX = "ws_planning_filter_";

function loadStringArray(key: string): string[] {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

function loadString(key: string): string {
  try { return localStorage.getItem(KEY_PREFIX + key) ?? ""; }
  catch { return ""; }
}

export function usePersistedStringArray(key: string): [string[], (next: string[]) => void] {
  const [value, setValue] = useState<string[]>(() => loadStringArray(key));
  useEffect(() => {
    try { localStorage.setItem(KEY_PREFIX + key, JSON.stringify(value)); } catch { /* ignore */ }
  }, [key, value]);
  return [value, setValue];
}

export function usePersistedString(key: string): [string, (next: string) => void] {
  const [value, setValue] = useState<string>(() => loadString(key));
  useEffect(() => {
    try { localStorage.setItem(KEY_PREFIX + key, value); } catch { /* ignore */ }
  }, [key, value]);
  return [value, setValue];
}
