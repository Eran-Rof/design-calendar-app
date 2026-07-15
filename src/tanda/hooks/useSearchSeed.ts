// useSearchSeed — seed a list panel's search box from a `?q=` drill param.
//
// The always-visible top-bar universal search (TopbarGlobalSearch) navigates to
// a master/list module with `?m=<module>&q=<code>` so the operator lands on the
// searched record. Master panels that don't already read `?q=` use this hook to
// (a) seed their search box from the param and (b) strip it on mount so it
// doesn't silently re-apply the filter when the operator returns to the panel
// later (the lingering-filter footgun documented in scorecardDrill).
//
// Usage:
//   const seed = useSearchSeed();
//   const { value: q, ... } = useDebouncedSearch(seed, 200);
// or
//   const [q, setQ] = useState(useSearchSeed());

import { useEffect } from "react";
import { readDrillParam, consumeDrillParams } from "../scorecardDrill";

export function useSearchSeed(): string {
  const seed = readDrillParam("q");
  useEffect(() => {
    if (seed) consumeDrillParams(["q"]);
    // Consume once on mount; `seed` is captured from the initial URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return seed;
}

export default useSearchSeed;
