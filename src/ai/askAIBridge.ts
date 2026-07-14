// Tiny event bridge for opening the Ask AI panel from anywhere in
// the tree without prop-drilling (PR 4/4 vanilla-Claude UX).
//
// Use case: right-click "Ask AI about this row" in the ATS grid
// dispatches an event with a generated prompt; the panel's host
// (NavBar.tsx) listens for the event, sets its state, and passes
// the prompt down to AskAIPanel as `draftInput`. Future surfaces
// (Toolbar buttons, other grids, the popup menus in PO WIP / DC /
// Planning) can hook in with one line.
//
// Why an event vs. context vs. a global zustand store:
//   - Context would require wrapping every host in a Provider.
//   - A store adds a dependency for one event type.
//   - CustomEvent on window is ~10 lines of code, type-safe via
//     the helpers below, and works across React trees (e.g. if
//     the panel ever moves to a portal or a separate iframe).

export interface AskAIRequest {
  /** The text the panel should pre-fill in the input. Operator can
   *  edit before sending. */
  prompt: string;
  /** Optional source tag for telemetry / debugging — e.g.
   *  "ats-row-context-menu", "po-wip-grid", "manual". */
  source?: string;
}

const EVENT_NAME = "rof:ask-ai";

/**
 * Dispatch an Ask AI request. The panel host listens for this and
 * pops the panel open with the prompt pre-filled. Safe to call from
 * anywhere — silently no-ops if no host is mounted.
 */
export function askAI(request: AskAIRequest): void {
  if (typeof window === "undefined") return;
  if (!request?.prompt) return;
  const event = new CustomEvent<AskAIRequest>(EVENT_NAME, { detail: request });
  window.dispatchEvent(event);
}

/**
 * Subscribe to Ask AI requests. The host calls this in a useEffect
 * and gets a cleanup function back. Detail is the full request shape.
 */
export function onAskAIRequest(handler: (req: AskAIRequest) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const wrapped = (e: Event) => {
    const ce = e as CustomEvent<AskAIRequest>;
    if (ce.detail) handler(ce.detail);
  };
  window.addEventListener(EVENT_NAME, wrapped);
  return () => window.removeEventListener(EVENT_NAME, wrapped);
}

/**
 * Pure helper to build a readable Ask AI prompt from an ATS row.
 * Lives here so it can be re-used by other grids (PO WIP, planning)
 * and unit-tested without spinning the grid up.
 *
 * The prompt deliberately leads with the visible data (sku, style,
 * customer, status) and trails with a short request so the operator
 * sees what's being asked.
 */
export interface RowSummary {
  sku?: string;
  style?: string;
  description?: string;
  category?: string;
  store?: string;
  onHand?: number;
  onOrder?: number;
  onPO?: number;
  customer?: string;
  /** Anything else worth surfacing — rendered as `key: value` lines. */
  extras?: Record<string, string | number | null | undefined>;
}

export function buildRowAskPrompt(row: RowSummary): string {
  const lines: string[] = [];
  if (row.sku)         lines.push(`SKU: ${row.sku}`);
  if (row.style && row.style !== row.sku) lines.push(`Style: ${row.style}`);
  if (row.description) lines.push(`Description: ${row.description}`);
  if (row.category)    lines.push(`Category: ${row.category}`);
  if (row.store)       lines.push(`Store: ${row.store}`);
  if (typeof row.onHand  === "number") lines.push(`On hand: ${row.onHand}`);
  if (typeof row.onOrder === "number") lines.push(`On order: ${row.onOrder}`);
  if (typeof row.onPO    === "number") lines.push(`On PO: ${row.onPO}`);
  if (row.customer)    lines.push(`Customer: ${row.customer}`);
  if (row.extras) {
    for (const [k, v] of Object.entries(row.extras)) {
      if (v == null || v === "") continue;
      lines.push(`${k}: ${v}`);
    }
  }
  const header = lines.join("\n");
  return `About this row:\n${header}\n\nTell me anything notable: recent shipment trend, open commitments, churn signal, related styles.`;
}

// ── P28-3: screen-context feed (companion mode) ─────────────────────────
//
// The reverse direction of this bridge: the HOST tells the assistant what
// the operator is looking at. The Tangerine shell publishes on every
// module change ({ panel_key, label }); individual panels may re-publish
// with richer detail (a record id, active filters) while mounted. The
// Ask AI panel reads the CURRENT context when a question is sent and
// forwards it to the server as `screen_context`, so "why is this one
// unbalanced?" needs no restating of where the operator is.
//
// Module-level store (not React state): the panel only needs the value
// at send time, and a plain variable works across React trees.

export interface ScreenContext {
  /** Tangerine module key (or another app's stable screen id). */
  panel_key: string;
  /** Human label ("Journal Entries"). */
  label?: string;
  /** Small key→value bag: record ids, active filter values. Clamped
   *  server-side — keep it to what a colleague would need to follow. */
  params?: Record<string, string>;
  /** One free-text line of extra orientation ("viewing JE-2026-00412"). */
  detail?: string;
}

let currentScreen: ScreenContext | null = null;

/** Host/panels call on navigation or when richer context is available.
 *  Pass null when leaving a screen. */
export function publishScreenContext(ctx: ScreenContext | null): void {
  currentScreen = ctx && ctx.panel_key ? ctx : null;
}

/** Read the operator's current screen (null when nothing published). */
export function getScreenContext(): ScreenContext | null {
  return currentScreen;
}
