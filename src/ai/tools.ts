// Action shapes returned by /api/ai/ask-grid. Mirror of the tool schema
// declared on the server. Keep both sides in lockstep — if a new tool is
// added to the handler, add the matching variant here.

export interface ApplyFiltersAction {
  type: "apply_filters";
  params: {
    search?: string;
    category?: string[];
    sub_category?: string[];
    style?: string[];
    gender?: string | string[];
    status?: string;
    min_ats?: number | null;
    store?: string[];
  };
}

export interface SetSortAction {
  type: "set_sort";
  params: { col: string; dir: "asc" | "desc" };
}

export interface ClearFiltersAction {
  type: "clear_filters";
  params: Record<string, never>;
}

// P28-2 — assistant navigation: open a Tangerine panel (client-side hop).
export interface OpenPanelAction {
  type: "open_panel";
  params: { panel: string; q?: string };
}

// P28-4 — assistant draft action: show a Confirm card for a previewed write.
// On Confirm the panel POSTs the token to the authenticated confirm endpoint;
// the model never performs the write.
export interface PresentConfirmationAction {
  type: "present_confirmation";
  params: { summary: string; token: string; action: string };
}

export type AIAction =
  | ApplyFiltersAction | SetSortAction | ClearFiltersAction | OpenPanelAction | PresentConfirmationAction;

// Optional follow-up the server can return alongside an answer. Used
// when Claude wants to propose a grid filter the user can opt into
// with one click (per phase-2 "ask first, push on confirm" UX).
export interface GridSuggestion {
  label: string;
  filters: ApplyFiltersAction["params"];
}

// One row in the server-side tool-call trace. Surfaced in the panel as
// dim text under the AI reply so operators can see what was looked up.
export interface ToolTraceEntry {
  tool: string;
  summary: string;
}

export interface AskAIResponse {
  text: string;
  actions: AIAction[];
  suggestion?: GridSuggestion | null;
  /** 1-3 short follow-up questions the panel can render as clickable
   *  chips below the AI reply. Each ≤ 70 chars, server-trimmed. */
  followups?: string[] | null;
  trace?: ToolTraceEntry[];
  token_usage?: {
    input_tokens: number | null;
    output_tokens: number | null;
    cost_usd: number;
  };
  // Present when the answer came from ip_ai_answer_cache instead of a
  // fresh Claude run. cached_age_seconds tells the client how stale.
  cached?: boolean;
  cached_age_seconds?: number;
}

export interface AskAIHistoryTurn {
  role: "user" | "assistant";
  text: string;
}

// Snapshot of the live grid state passed to the API on every question.
// Keep the shape narrow — the server caps row counts + distinct lengths,
// but we still want to avoid wiring giant blobs into the request body.
export interface GridContextSnapshot {
  columns: string[];
  active_filters: {
    search?: string;
    category?: string[];
    sub_category?: string[];
    style?: string[];
    gender?: string | string[];
    status?: string;
    min_ats?: number | null;
    store?: string[];
    customer?: string;
  };
  sort?: { col: string; dir: "asc" | "desc" } | null;
  row_count: number;
  // Grid-wide visible totals — sum across all currently-filtered rows,
  // NOT scoped by customer or by date. Renamed with the grid_visible_ /
  // grid_fallback_ prefixes so the AI cannot mistake them for query
  // results in a customer-scoped or date-scoped answer. See the rule in
  // api/_lib/ai/rof-glossary.js (anti-fabrication rule 7).
  totals?: {
    _caveat?: string;
    grid_visible_on_hand?: number;
    grid_visible_on_po?: number;
    grid_visible_on_order?: number;
    grid_visible_so_value?: number;
    grid_visible_po_value?: number;
    grid_fallback_margin_pct?: number;
  };
  distinct: {
    categories: string[];
    sub_categories: string[];
    styles: string[];
    genders: string[];
    stores: string[];
  };
  sample_rows?: Array<Record<string, unknown>>;
}

// Setters the panel needs to apply actions. All optional so callers only
// have to wire what they use; missing setters silently no-op.
export interface AIGridSetters {
  setSearch?: (v: string | ((p: string) => string)) => void;
  setFilterCategory?: (v: string[] | ((p: string[]) => string[])) => void;
  setFilterSubCategory?: (v: string[] | ((p: string[]) => string[])) => void;
  setFilterStyle?: (v: string[] | ((p: string[]) => string[])) => void;
  setFilterGender?: (v: string[] | ((p: string[]) => string[])) => void;
  setFilterStatus?: (v: string | ((p: string) => string)) => void;
  setMinATS?: (v: number | "" | ((p: number | "") => number | "")) => void;
  setStoreFilter?: (v: string[] | ((p: string[]) => string[])) => void;
  setSortCol?: (v: string | null | ((p: string | null) => string | null)) => void;
  setSortDir?: (v: "asc" | "desc" | ((p: "asc" | "desc") => "asc" | "desc")) => void;
  setActiveSort?: (v: string | null | ((p: string | null) => string | null)) => void;
}

// Default filter values used by clear_filters. Lifted verbatim from
// atsTypes.ts initial state so the AI "reset" matches the toolbar Reset.
const FILTER_DEFAULTS = {
  search: "",
  category: [] as string[],
  sub_category: [] as string[],
  style: [] as string[],
  gender: [] as string[],
  status: "All",
  min_ats: "" as number | "",
  store: ["All"] as string[],
};

export function applyAction(action: AIAction, setters: AIGridSetters): void {
  switch (action.type) {
    case "apply_filters": {
      const p = action.params || {};
      if (typeof p.search === "string"     && setters.setSearch)            setters.setSearch(p.search);
      if (Array.isArray(p.category)        && setters.setFilterCategory)    setters.setFilterCategory(p.category);
      if (Array.isArray(p.sub_category)    && setters.setFilterSubCategory) setters.setFilterSubCategory(p.sub_category);
      if (Array.isArray(p.style)           && setters.setFilterStyle)       setters.setFilterStyle(p.style);
      // Accept either an array (preferred — multi-select) or a single
      // string for backward compat with older AI prompts. "All" / "" /
      // null collapses to [] (no filter).
      if (setters.setFilterGender) {
        if (Array.isArray(p.gender)) {
          setters.setFilterGender(p.gender);
        } else if (typeof p.gender === "string") {
          setters.setFilterGender(p.gender === "All" || p.gender === "" ? [] : [p.gender]);
        }
      }
      if (typeof p.status === "string"     && setters.setFilterStatus)      setters.setFilterStatus(p.status);
      if ("min_ats" in p && setters.setMinATS) {
        setters.setMinATS(p.min_ats == null ? "" : p.min_ats);
      }
      if (Array.isArray(p.store)           && setters.setStoreFilter)       setters.setStoreFilter(p.store);
      return;
    }
    case "set_sort": {
      const { col, dir } = action.params;
      if (setters.setSortCol)    setters.setSortCol(col);
      if (setters.setSortDir)    setters.setSortDir(dir);
      if (setters.setActiveSort) setters.setActiveSort(col);
      return;
    }
    case "clear_filters": {
      if (setters.setSearch)            setters.setSearch(FILTER_DEFAULTS.search);
      if (setters.setFilterCategory)    setters.setFilterCategory(FILTER_DEFAULTS.category);
      if (setters.setFilterSubCategory) setters.setFilterSubCategory(FILTER_DEFAULTS.sub_category);
      if (setters.setFilterStyle)       setters.setFilterStyle(FILTER_DEFAULTS.style);
      if (setters.setFilterGender)      setters.setFilterGender(FILTER_DEFAULTS.gender);
      if (setters.setFilterStatus)      setters.setFilterStatus(FILTER_DEFAULTS.status);
      if (setters.setMinATS)            setters.setMinATS(FILTER_DEFAULTS.min_ats);
      if (setters.setStoreFilter)       setters.setStoreFilter(FILTER_DEFAULTS.store);
      return;
    }
  }
}

// Apply an AI-suggested grid view. Same effect as apply_filters but
// scoped behind the user clicking the "Push to grid" button, so the
// AI never mutates the grid without explicit confirmation when going
// through the suggestion path.
export function applySuggestion(suggestion: GridSuggestion, setters: AIGridSetters): void {
  applyAction({ type: "apply_filters", params: suggestion.filters }, setters);
}

// Tier 1C of the Ask AI improvement plan — discoverability via real
// operator-asked questions. Reads ip_ai_answer_cache directly (PostgREST,
// no PII in the table — just question text + popularity counters).
// Returns the top N most-hit questions, deduped by lowercased text.
// Falls back to an empty array on any failure so the panel can roll back
// to its static samplePrompts list cleanly.
//
// Why answer_cache and not call_log: answer_cache.question is populated,
// call_log doesn't store the question text. Cache also has hit_count
// which is the popularity signal we want.
export async function fetchPopularPrompts(opts?: {
  limit?: number;
  /** Absolute Supabase URL. Test entry point — defaults to import.meta env. */
  sbUrl?: string;
  /** Auth headers. Test entry point — defaults to import.meta env. */
  sbHeaders?: Record<string, string>;
  /** Test injection point for fetch (defaults to global). */
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  const limit = Math.max(1, Math.min(20, opts?.limit ?? 10));
  const sbUrl = opts?.sbUrl
    ?? ((import.meta.env.VITE_SUPABASE_URL as string | undefined) || "").trim();
  const sbHeaders = opts?.sbHeaders ?? ((): Record<string, string> => {
    const key = ((import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || "").trim();
    return key
      ? { apikey: key, Authorization: `Bearer ${key}` }
      : {};
  })();
  if (!sbUrl) return [];

  const f = opts?.fetchImpl ?? fetch;
  // Pull 3x the requested limit so dedup-by-lowercased-text leaves us
  // enough rows; ip_ai_answer_cache rows differ on grid context, so a
  // single question can appear under multiple hashes.
  const url = `${sbUrl}/rest/v1/ip_ai_answer_cache?select=question,hit_count&order=hit_count.desc&limit=${limit * 3}`;
  try {
    const res = await f(url, { headers: sbHeaders });
    if (!res.ok) return [];
    const rows = await res.json() as Array<{ question: string | null; hit_count: number | null }>;
    return dedupePopular(rows, limit);
  } catch {
    return [];
  }
}

/** Deduplicate by lowercased question text, preserving the first
 *  occurrence (highest hit_count wins because rows arrive sorted).
 *  Exported for unit testing. */
export function dedupePopular(
  rows: Array<{ question: string | null; hit_count?: number | null }>,
  limit: number,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const q = String(r?.question ?? "").trim();
    if (!q) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= limit) break;
  }
  return out;
}

// Human-readable summary of an action, shown inline in the chat panel so
// the operator sees what the AI just did to the grid.
export function describeAction(action: AIAction): string {
  switch (action.type) {
    case "apply_filters": {
      const parts: string[] = [];
      const p = action.params;
      if (typeof p.search === "string")           parts.push(`search="${p.search}"`);
      if (Array.isArray(p.category))              parts.push(`category=${p.category.length ? p.category.join(",") : "(any)"}`);
      if (Array.isArray(p.sub_category))          parts.push(`sub=${p.sub_category.length ? p.sub_category.join(",") : "(any)"}`);
      if (Array.isArray(p.style))                 parts.push(`style=${p.style.length ? p.style.join(",") : "(any)"}`);
      if (Array.isArray(p.gender))                parts.push(`gender=${p.gender.length ? p.gender.join(",") : "(any)"}`);
      else if (typeof p.gender === "string")      parts.push(`gender=${p.gender}`);
      if (typeof p.status === "string")           parts.push(`status=${p.status}`);
      if ("min_ats" in p)                          parts.push(`min ATS=${p.min_ats ?? "(any)"}`);
      if (Array.isArray(p.store))                 parts.push(`stores=${p.store.join(",") || "(any)"}`);
      return parts.length ? `Applied filters: ${parts.join(", ")}` : "Applied filters (no changes)";
    }
    case "set_sort":     return `Sorted by ${action.params.col} ${action.params.dir}`;
    case "clear_filters": return "Cleared all filters";
    case "open_panel":   return `Opened ${action.params.panel}${action.params.q ? ` (search "${action.params.q}")` : ""}`;
    // present_confirmation is rendered as an interactive Confirm card, not a
    // one-line "what happened" footnote — but keep the switch exhaustive.
    case "present_confirmation": return `Awaiting confirmation: ${action.params.action}`;
  }
}
