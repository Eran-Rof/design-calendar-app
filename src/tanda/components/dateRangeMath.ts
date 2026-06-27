// Cross-cutter T7-1 — Pure date-range preset helpers.
//
// All helpers take an optional `today` arg so tests pass a fixed date
// (no Date.now() mocking needed). All formatting uses local Y/M/D
// components — NEVER .toISOString() which can shift by ±1 day depending
// on the browser timezone (arch §6 TZ-drift risk).

export type Preset = {
  key: string;
  label: string;
  compute: (today?: Date) => { from: string; to: string };
};

// ---------- Date math helpers ----------

/**
 * Format a Date as a local YYYY-MM-DD string, using the year/month/day
 * components directly. Avoids the .toISOString().slice(0,10) trap which
 * shifts by up to ±1 day in non-UTC zones.
 */
export function iso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function endOfMonth(d: Date): Date {
  // Day 0 of next month = last day of this month.
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

export function startOfYear(d: Date): Date {
  return new Date(d.getFullYear(), 0, 1);
}

export function endOfYear(d: Date): Date {
  return new Date(d.getFullYear(), 11, 31);
}

export function addDays(d: Date, n: number): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  out.setDate(out.getDate() + n);
  return out;
}

/**
 * First day of the calendar quarter containing `d`.
 * Q1 = Jan-Mar, Q2 = Apr-Jun, Q3 = Jul-Sep, Q4 = Oct-Dec.
 */
export function startOfQuarter(d: Date): Date {
  const q = Math.floor(d.getMonth() / 3); // 0..3
  return new Date(d.getFullYear(), q * 3, 1);
}

/**
 * Last day of the calendar quarter containing `d`.
 */
export function endOfQuarter(d: Date): Date {
  const q = Math.floor(d.getMonth() / 3); // 0..3
  // day 0 of (start of next quarter) = last day of this quarter
  return new Date(d.getFullYear(), q * 3 + 3, 0);
}

// ---------- Presets ----------

/**
 * The 12 default presets per arch §1. Order matters: chips render in
 * this order, with "custom" rendered last as an escape hatch that
 * returns sentinel empty strings (caller opens manual pickers).
 */
export const DEFAULT_PRESETS: Preset[] = [
  {
    key: "mtd",
    label: "MTD",
    compute: (t = new Date()) => ({
      from: iso(startOfMonth(t)),
      to: iso(t),
    }),
  },
  {
    key: "ytd",
    label: "YTD",
    compute: (t = new Date()) => ({
      from: iso(startOfYear(t)),
      to: iso(t),
    }),
  },
  {
    key: "ty",
    label: "This Year",
    compute: (t = new Date()) => ({
      from: iso(startOfYear(t)),
      to: iso(endOfYear(t)),
    }),
  },
  {
    key: "ly",
    label: "Last Year",
    compute: (t = new Date()) => {
      const ly = new Date(t.getFullYear() - 1, 0, 1);
      return {
        from: iso(startOfYear(ly)),
        to: iso(endOfYear(ly)),
      };
    },
  },
  {
    key: "ty_to_last_month",
    label: "TY → last month",
    compute: (t = new Date()) => {
      // Last day of prior month = day 0 of current month.
      const lastDayPriorMonth = new Date(t.getFullYear(), t.getMonth(), 0);
      return {
        from: iso(startOfYear(t)),
        to: iso(lastDayPriorMonth),
      };
    },
  },
  {
    key: "last_month",
    label: "Last month",
    compute: (t = new Date()) => {
      // Pick a date inside the prior month, then bracket it.
      const inPriorMonth = new Date(t.getFullYear(), t.getMonth(), 0);
      return {
        from: iso(startOfMonth(inPriorMonth)),
        to: iso(endOfMonth(inPriorMonth)),
      };
    },
  },
  {
    key: "last_30d",
    label: "Last 30d",
    compute: (t = new Date()) => ({
      from: iso(addDays(t, -30)),
      to: iso(t),
    }),
  },
  {
    key: "last_60d",
    label: "Last 60d",
    compute: (t = new Date()) => ({
      from: iso(addDays(t, -60)),
      to: iso(t),
    }),
  },
  {
    key: "last_90d",
    label: "Last 90d",
    compute: (t = new Date()) => ({
      from: iso(addDays(t, -90)),
      to: iso(t),
    }),
  },
  {
    key: "last_quarter",
    label: "Last Quarter",
    compute: (t = new Date()) => {
      // First day of current quarter, then step back one day = inside prior quarter.
      const startThisQ = startOfQuarter(t);
      const inPriorQ = new Date(
        startThisQ.getFullYear(),
        startThisQ.getMonth(),
        0,
      );
      return {
        from: iso(startOfQuarter(inPriorQ)),
        to: iso(endOfQuarter(inPriorQ)),
      };
    },
  },
  {
    key: "custom",
    label: "Custom…",
    // Sentinel: caller opens manual pickers when from/to come back empty.
    compute: () => ({ from: "", to: "" }),
  },
];

/**
 * Resolve a preset key to its { from, to } range (YYYY-MM-DD). Looks the key up
 * in DEFAULT_PRESETS; unknown/aliased keys (e.g. "last30days" → "last_30d")
 * fall back to a trailing 30-day window so callers always get a usable range.
 *
 * (InternalReconciliationDashboard imports this; it was missing, which broke the
 * production rollup build once #983 pulled that panel into the build graph.)
 */
export function computePreset(key: string, today: Date = new Date()): { from: string; to: string } {
  const p = DEFAULT_PRESETS.find((x) => x.key === key);
  if (p && p.key !== "custom") return p.compute(today);
  return { from: iso(addDays(today, -29)), to: iso(today) };
}

// ---------- Date Presets master (user-defined, relative `kind` + optional n) ----------

export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, d.getDate());
}

export type DatePresetMasterRow = {
  id: string;
  label: string;
  kind: string;       // see VALID_KINDS in api/_handlers/internal/date-presets
  n: number | null;
  sort_order?: number;
  is_active?: boolean;
  /**
   * When set, this row MIRRORS a code DEFAULT_PRESET with this key (the master
   * is backfilled with the current built-ins so operators can manage them).
   * mergePresets() suppresses the matching code built-in so each preset shows
   * exactly once — the editable master row wins.
   */
  source_key?: string | null;
};

/** Compute a relative-expression preset (the master `kind` + n) → {from,to}. */
export function computeForKind(kind: string, n: number | null, t: Date = new Date()): { from: string; to: string } {
  switch (kind) {
    case "today":            return { from: iso(t), to: iso(t) };
    case "yesterday":        return { from: iso(addDays(t, -1)), to: iso(addDays(t, -1)) };
    case "last_n_days":      return { from: iso(addDays(t, -(n || 30))), to: iso(t) };
    case "last_n_months":    return { from: iso(addMonths(t, -(n || 1))), to: iso(t) };
    case "mtd":              return { from: iso(startOfMonth(t)), to: iso(t) };
    case "ytd":              return { from: iso(startOfYear(t)), to: iso(t) };
    case "this_month":       return { from: iso(startOfMonth(t)), to: iso(endOfMonth(t)) };
    case "this_year":        return { from: iso(startOfYear(t)), to: iso(endOfYear(t)) };
    case "this_quarter":     return { from: iso(startOfQuarter(t)), to: iso(endOfQuarter(t)) };
    case "last_quarter": {
      const inPriorQ = new Date(startOfQuarter(t).getFullYear(), startOfQuarter(t).getMonth(), 0);
      return { from: iso(startOfQuarter(inPriorQ)), to: iso(endOfQuarter(inPriorQ)) };
    }
    case "last_month": {
      const inPrior = new Date(t.getFullYear(), t.getMonth(), 0);
      return { from: iso(startOfMonth(inPrior)), to: iso(endOfMonth(inPrior)) };
    }
    case "last_year": {
      const ly = new Date(t.getFullYear() - 1, 0, 1);
      return { from: iso(startOfYear(ly)), to: iso(endOfYear(ly)) };
    }
    case "ty_to_last_month":
      return { from: iso(startOfYear(t)), to: iso(new Date(t.getFullYear(), t.getMonth(), 0)) };
    default:
      return { from: iso(addDays(t, -29)), to: iso(t) };
  }
}

/** Map a Date Presets master row → a runtime Preset (key prefixed to avoid clashes). */
export function presetFromMasterRow(row: DatePresetMasterRow): Preset {
  return {
    key: `custom:${row.id}`,
    label: row.label,
    compute: (t = new Date()) => computeForKind(row.kind, row.n, t),
  };
}

/**
 * Merge the code DEFAULT_PRESETS (or a provided base) with the operator's
 * custom presets from the Date Presets master, keeping the "custom" sentinel
 * last. Used by <DateRangePresets/> so every date-range picker shows the
 * operator's additional presets automatically.
 */
export function mergePresets(base: Preset[], custom: DatePresetMasterRow[]): Preset[] {
  const activeRows = (custom || []).filter((r) => r.is_active !== false);
  // Built-ins backfilled into the master carry a source_key naming the code
  // preset they mirror — suppress that built-in so it isn't shown twice (the
  // editable master row wins). Operator-added rows have no source_key.
  const covered = new Set(activeRows.map((r) => r.source_key).filter(Boolean) as string[]);
  const customPresets = activeRows.map(presetFromMasterRow);
  const sentinel = base.find((p) => p.key === "custom");
  const builtins = base.filter((p) => p.key !== "custom" && !covered.has(p.key));
  return sentinel ? [...builtins, ...customPresets, sentinel] : [...builtins, ...customPresets];
}
