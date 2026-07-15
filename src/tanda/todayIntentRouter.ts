// src/tanda/todayIntentRouter.ts
//
// P28 — the Today page "What do you want to work on?" field is a pure
// intent ROUTER, not a chat: the operator types a phrase and the app
// navigates them straight to the owning panel / live to-do. The floating
// Ask AI button (every page) stays the surface for actual Q&A.
//
// resolveIntent() is a PURE, unit-tested function over the ALREADY-LOADED
// Today data (todos + suggestions) plus the static module registry — it
// issues no queries and touches no DOM. The InternalToday component turns
// its result into a navigation (a to-do → openItem; a module → goToPanel)
// or, when ambiguous, into clickable alternative chips.
//
// Scoring (see resolveIntent): the intent is normalised (lowercased,
// filler stripped, punctuation removed) and expanded through a synonym /
// alias map so common phrasings hit the right target. Each candidate scores
// on (a) STRONG identifier hits — the intent/alias naming a to-do's pack,
// panel or a module's key (×3) — plus (b) plain word overlap (×1). A small
// per-kind bonus breaks ties toward a live TO-DO over a bare module, so
// "pos flagged here" opens the flagged-PO to-do rather than the generic
// Procurement panel. Only a confident best match routes; otherwise we return
// `none` with up to three alternatives for the operator to pick from.

export type IntentTodo = {
  key: string;
  title: string;
  detail?: string;
  count?: number;
  severity?: "action" | "warn" | "error" | "info";
  panel?: string | null;
  href?: string;
  pack?: string;
};

export type IntentSuggestion = {
  key: string;
  text: string;
  panel?: string | null;
};

export type IntentModule = {
  key: string;
  label: string;
  group?: string;
};

export type IntentTargetKind = "todo" | "module" | "suggestion";

export type IntentAlternative = {
  kind: IntentTargetKind;
  label: string;
  todo?: IntentTodo;
  module?: IntentModule;
  suggestion?: IntentSuggestion;
};

export type ResolveResult = {
  kind: "todo" | "module" | "suggestion" | "none";
  todo?: IntentTodo;
  module?: IntentModule;
  suggestion?: IntentSuggestion;
  score: number;
  alternatives: IntentAlternative[];
};

// Words that carry no routing signal — the operator's framing, not the target.
const FILLER = new Set([
  "work", "working", "on", "go", "goto", "to", "open", "opening", "take", "takes",
  "me", "the", "a", "an", "here", "flagged", "flag", "my", "mine", "review",
  "reviewing", "want", "wanna", "wants", "i", "id", "please", "pls", "show",
  "showme", "view", "let", "lets", "need", "needs", "get", "getting", "into",
  "in", "at", "with", "for", "of", "and", "some", "this", "that", "do", "doing",
]);

// Synonym / alias map: an intent token expands to extra identifier + word
// tokens so common phrasings ("po", "close", "bill") reach the canonical
// target. Values are matched BOTH as strong identifiers (against a candidate's
// key / pack / panel) and, after splitting on "_", as plain words.
const ALIASES: Record<string, string[]> = {
  // Month-End Close.
  close: ["month_end_close"],
  closing: ["month_end_close"],
  monthend: ["month_end_close"],
  "month-end": ["month_end_close"],
  // Procurement / Purchase Orders. "po" is included so a live PO to-do (pack
  // "po") is matched; panel keys are deliberately NOT aliased here so they
  // don't inflate unrelated modules of the same name.
  po: ["po", "procurement", "purchase_orders", "purchasing"],
  pos: ["po", "procurement", "purchase_orders", "purchasing"],
  purchase: ["po", "procurement", "purchase_orders"],
  purchasing: ["po", "procurement", "purchase_orders"],
  procurement: ["procurement", "purchase_orders"],
  receiving: ["procurement", "receiving", "purchase_orders"],
  // Sales orders / allocation.
  so: ["sales_orders", "sales_allocations"],
  sos: ["sales_orders", "sales_allocations"],
  sale: ["sales_orders"],
  sales: ["sales_orders"],
  order: ["sales_orders"],
  orders: ["sales_orders"],
  allocation: ["sales_allocations"],
  allocations: ["sales_allocations"],
  allocate: ["sales_allocations"],
  // Accounts receivable.
  ar: ["ar_invoices", "ar_aging"],
  receivable: ["ar_invoices", "ar_aging"],
  receivables: ["ar_invoices", "ar_aging"],
  // Accounts payable / bills.
  ap: ["ap_invoices", "ap_aging"],
  payable: ["ap_invoices", "ap_aging"],
  payables: ["ap_invoices", "ap_aging"],
  bill: ["ap_invoices", "ap_aging"],
  bills: ["ap_invoices", "ap_aging"],
  // Chargebacks.
  chargeback: ["chargebacks"],
  chargebacks: ["chargebacks"],
  // Journal entries.
  je: ["journal_entries"],
  jes: ["journal_entries"],
  journal: ["journal_entries"],
  journals: ["journal_entries"],
  // Bank reconciliation.
  bank: ["bank_reconciliation"],
  recon: ["bank_reconciliation", "factor_recon"],
  reconciliation: ["bank_reconciliation", "factor_recon"],
  reconcile: ["bank_reconciliation", "factor_recon"],
  // Factor.
  factor: ["factor_recon"],
  factoring: ["factor_recon"],
  rosenthal: ["factor_recon"],
  // Customer service cases.
  case: ["cases"],
  cases: ["cases"],
  ticket: ["cases"],
  tickets: ["cases"],
  // Approvals.
  approval: ["approval_requests"],
  approvals: ["approval_requests"],
  approve: ["approval_requests"],
};

// Strong-identifier weight (naming a to-do's pack/panel or a module's key)
// vs plain word-overlap weight.
const STRONG = 3;
const WORD = 1;
// Per-kind tie-break so a live TO-DO edges out a bare module at equal score.
const KIND_BONUS: Record<IntentTargetKind, number> = { todo: 0.5, suggestion: 0.25, module: 0 };
// Minimum raw score to route confidently; below this we surface alternatives.
const CONFIDENT = 3;
const SEVERITY_RANK: Record<string, number> = { action: 0, error: 0, warn: 1, info: 2 };

function tokenize(s: string): string[] {
  return String(s || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/** Normalise the raw intent into content tokens (filler + punctuation gone). */
export function normalizeIntent(intent: string): string[] {
  return tokenize(intent).filter((t) => !FILLER.has(t));
}

/** Intent → { ids, words }: strong identifier hints + plain word set, both
 *  expanded through the alias map. Pure; exported for tests. */
export function expandIntent(intent: string): { ids: Set<string>; words: Set<string> } {
  const tokens = normalizeIntent(intent);
  const ids = new Set<string>();
  const words = new Set<string>();
  for (const t of tokens) {
    ids.add(t);
    words.add(t);
    for (const alias of ALIASES[t] || []) {
      ids.add(alias);
      for (const w of alias.split("_")) if (w.length >= 2) words.add(w);
    }
  }
  return { ids, words };
}

function scoreCandidate(
  ident: string[],
  words: string[],
  exp: { ids: Set<string>; words: Set<string> },
): number {
  let strong = 0;
  for (const id of ident) if (id && exp.ids.has(id)) strong += 1;
  let overlap = 0;
  const seen = new Set<string>();
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    if (exp.words.has(w)) overlap += 1;
  }
  return strong * STRONG + overlap * WORD;
}

function todoIdentifiers(t: IntentTodo): string[] {
  const out: string[] = [];
  if (t.pack) out.push(String(t.pack).toLowerCase());
  if (t.panel) out.push(String(t.panel).toLowerCase());
  if (t.key) out.push(String(t.key).toLowerCase());
  return out;
}

function todoWords(t: IntentTodo): string[] {
  return tokenize(`${t.title || ""} ${t.detail || ""} ${t.key || ""} ${t.pack || ""} ${t.panel || ""}`);
}

function moduleWords(m: IntentModule): string[] {
  return tokenize(`${m.label || ""} ${m.key || ""} ${m.group || ""}`);
}

function suggestionWords(s: IntentSuggestion): string[] {
  return tokenize(`${s.text || ""} ${s.panel || ""}`);
}

type Scored =
  | { kind: "todo"; score: number; todo: IntentTodo }
  | { kind: "module"; score: number; module: IntentModule }
  | { kind: "suggestion"; score: number; suggestion: IntentSuggestion };

function labelOf(s: Scored): string {
  if (s.kind === "todo") return s.todo.title;
  if (s.kind === "module") return s.module.label;
  return s.suggestion.text;
}

function altOf(s: Scored): IntentAlternative {
  if (s.kind === "todo") return { kind: "todo", label: s.todo.title, todo: s.todo };
  if (s.kind === "module") return { kind: "module", label: s.module.label, module: s.module };
  return { kind: "suggestion", label: s.suggestion.text, suggestion: s.suggestion };
}

/**
 * Resolve a free-text "what do you want to work on" phrase to a navigation.
 *
 * @param intent  the raw operator phrase
 * @param data.todos        the live Today to-dos (already loaded)
 * @param data.suggestions  the live suggestions (those with a panel are routable)
 * @param data.modules      the static Tangerine module registry (MODULES)
 * @returns { kind, todo?|module?|suggestion?, score, alternatives } — `none`
 *          when nothing is confident, carrying up to 3 alternatives to pick from.
 */
export function resolveIntent(
  intent: string,
  data: { todos?: IntentTodo[]; suggestions?: IntentSuggestion[]; modules?: IntentModule[] },
): ResolveResult {
  const todos = data.todos || [];
  const suggestions = data.suggestions || [];
  const modules = data.modules || [];

  const exp = expandIntent(intent);
  // Empty / all-filler intent — nothing to match. Offer the live to-dos as
  // a starting point so the field is never a dead end.
  if (exp.ids.size === 0) {
    return { kind: "none", score: 0, alternatives: fallbackAlternatives(todos, suggestions) };
  }

  const scored: Scored[] = [];
  for (const t of todos) {
    const score = scoreCandidate(todoIdentifiers(t), todoWords(t), exp);
    if (score > 0) scored.push({ kind: "todo", score, todo: t });
  }
  for (const s of suggestions) {
    if (!s.panel) continue; // only routable suggestions are candidates
    const score = scoreCandidate([String(s.panel).toLowerCase()], suggestionWords(s), exp);
    if (score > 0) scored.push({ kind: "suggestion", score, suggestion: s });
  }
  for (const m of modules) {
    if (!m.key || m.key === "today") continue;
    const score = scoreCandidate([String(m.key).toLowerCase()], moduleWords(m), exp);
    if (score > 0) scored.push({ kind: "module", score, module: m });
  }

  if (scored.length === 0) {
    return { kind: "none", score: 0, alternatives: fallbackAlternatives(todos, suggestions) };
  }

  // Rank: adjusted score (raw + kind bonus) desc. Among tied TO-DOs, prefer
  // higher severity then higher count (the "which flagged item" tie-break).
  const rank = (a: Scored, b: Scored): number => {
    const adj = (s: Scored) => s.score + KIND_BONUS[s.kind];
    const d = adj(b) - adj(a);
    if (Math.abs(d) > 1e-9) return d > 0 ? 1 : -1;
    if (a.kind === "todo" && b.kind === "todo") {
      const sa = SEVERITY_RANK[a.todo.severity || "info"] ?? 3;
      const sb = SEVERITY_RANK[b.todo.severity || "info"] ?? 3;
      if (sa !== sb) return sa - sb;
      return (b.todo.count || 0) - (a.todo.count || 0);
    }
    return 0;
  };
  scored.sort(rank);

  // Live-to-do preference: a CONFIDENT matching to-do wins even over a
  // higher-scoring bare module, because a flagged to-do is the actionable
  // thing the operator meant ("pos flagged here" → the PO to-do, not the
  // generic Procurement panel). Among matching to-dos pick highest severity
  // then highest count.
  const todosScored = scored.filter((s) => s.kind === "todo");
  let bestTodo = null;
  if (todosScored.length) {
    const maxT = Math.max(...todosScored.map((s) => s.score));
    bestTodo = todosScored
      .filter((s) => s.score === maxT)
      .sort((a, b) => {
        const sa = SEVERITY_RANK[a.todo.severity || "info"] ?? 3;
        const sb = SEVERITY_RANK[b.todo.severity || "info"] ?? 3;
        if (sa !== sb) return sa - sb;
        return (b.todo.count || 0) - (a.todo.count || 0);
      })[0];
  }

  const best = bestTodo && bestTodo.score >= CONFIDENT ? bestTodo : scored[0];
  const alternatives = scored.filter((s) => s !== best).slice(0, 3).map(altOf);

  if (best.score < CONFIDENT) {
    // Low-confidence: don't guess. Surface the near matches (incl. the best)
    // as chips, falling back to the live to-dos if there truly are none.
    const alts = scored.slice(0, 3).map(altOf);
    return {
      kind: "none",
      score: best.score,
      alternatives: alts.length ? alts : fallbackAlternatives(todos, suggestions),
    };
  }

  if (best.kind === "todo") return { kind: "todo", todo: best.todo, score: best.score, alternatives };
  if (best.kind === "suggestion") return { kind: "suggestion", suggestion: best.suggestion, score: best.score, alternatives };
  return { kind: "module", module: best.module, score: best.score, alternatives };
}

/** Top live to-dos (severity-first), then routable suggestions, as chips for a
 *  `none` result so the operator can pick instead of retyping. */
function fallbackAlternatives(todos: IntentTodo[], suggestions: IntentSuggestion[]): IntentAlternative[] {
  const out: IntentAlternative[] = [];
  const ranked = [...todos].sort((a, b) => {
    const sa = SEVERITY_RANK[a.severity || "info"] ?? 3;
    const sb = SEVERITY_RANK[b.severity || "info"] ?? 3;
    if (sa !== sb) return sa - sb;
    return (b.count || 0) - (a.count || 0);
  });
  for (const t of ranked) {
    out.push({ kind: "todo", label: t.title, todo: t });
    if (out.length >= 3) return out;
  }
  for (const s of suggestions) {
    if (!s.panel) continue;
    out.push({ kind: "suggestion", label: s.text, suggestion: s });
    if (out.length >= 3) return out;
  }
  return out;
}
