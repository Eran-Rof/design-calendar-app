// @mention autocomplete dropdown for the Ask AI textarea (PR 2/4).
//
// Wires to /api/internal/ai/mention-suggest. The parent panel passes:
//   - the current input value + caret position
//   - a callback to commit a selected entity into the input
//
// Detection rule: a token starting with `@` immediately after the
// start of input or after whitespace, with no spaces inside the token.
// When that token is ≥ 1 char of text, we fire a lookup. While the
// dropdown is open, ↑/↓/Enter/Tab/Esc are handled by THIS component
// (the parent receives a `wasHandled` signal from onKeyDown).
//
// Extracted to its own file per the architecture spirit: AskAIPanel
// is already at the line ceiling; new substantial features get
// their own module.

import { useEffect, useMemo, useRef, useState } from "react";

export type MentionType = "customer" | "style";

export interface MentionItem {
  id: string;       // ip_customer_master.id or style_code
  label: string;    // display name shown in the dropdown
  sublabel: string; // "Customer · CODE" / "Style · description"
  type: MentionType;
}

interface ParsedTrigger {
  startIdx: number;  // index of the `@` in the input
  query: string;     // text typed after the `@`
  type: MentionType; // currently always "customer" — see designed-decisions comment
}

/**
 * Parse the input for an active @mention trigger ending at `caret`.
 * Returns null when no token at that position. The trigger starts
 * with `@` immediately after start-of-input or whitespace; the typed
 * query continues until whitespace.
 *
 * Exported for unit testing.
 */
export function parseTrigger(value: string, caret: number): ParsedTrigger | null {
  const upTo = value.slice(0, caret);
  // Walk back from caret to find the last whitespace.
  const lastSpace = Math.max(upTo.lastIndexOf(" "), upTo.lastIndexOf("\n"), upTo.lastIndexOf("\t"));
  const tokenStart = lastSpace + 1;
  const token = upTo.slice(tokenStart);
  if (!token.startsWith("@")) return null;
  // Disallow `@` mid-word (e.g. an email "ross@store.com" should NOT
  // open the dropdown). The char before tokenStart must be space or
  // start-of-string.
  if (tokenStart > 0) {
    const prev = value[tokenStart - 1];
    if (prev && !/\s/.test(prev)) return null;
  }
  const query = token.slice(1);
  // Detection scope (deliberate v1 choice): one autocomplete kind at a
  // time, defaulting to customer. Style mentions live behind a `#`
  // trigger so the operator doesn't have to disambiguate one menu.
  return { startIdx: tokenStart, query, type: "customer" };
}

/**
 * Replace every `@Token` / `#Token` in `text` with an inlined
 * id-parenthetical form when a matching resolution exists in `map`.
 * Tokens with no entry are left untouched. Pure — exported for tests.
 *
 * Example:
 *   "Show @Burlington_Coat_Factory for #RYB0412 last month"
 *   →
 *   "Show Burlington Coat Factory (customer_id=abc123) for RYB0412
 *    (style_code=RYB0412) last month"
 */
export function expandMentionsForServer(
  text: string,
  map: Map<string, { id: string; type: "customer" | "style"; label: string }>,
): string {
  return text.replace(/([@#])([A-Za-z0-9_-]+)/g, (whole, sigil, token) => {
    const entry = map.get(token);
    if (!entry) return whole;
    if (entry.type === "customer" && sigil === "@") {
      return `${entry.label} (customer_id=${entry.id})`;
    }
    if (entry.type === "style" && sigil === "#") {
      return `${entry.label} (style_code=${entry.id})`;
    }
    return whole;
  });
}

/**
 * Same as parseTrigger but for `#` styles. Kept separate so a future
 * unified menu can merge them; for now `@` = customers, `#` = styles.
 */
export function parseStyleTrigger(value: string, caret: number): ParsedTrigger | null {
  const upTo = value.slice(0, caret);
  const lastSpace = Math.max(upTo.lastIndexOf(" "), upTo.lastIndexOf("\n"), upTo.lastIndexOf("\t"));
  const tokenStart = lastSpace + 1;
  const token = upTo.slice(tokenStart);
  if (!token.startsWith("#")) return null;
  if (tokenStart > 0) {
    const prev = value[tokenStart - 1];
    if (prev && !/\s/.test(prev)) return null;
  }
  return { startIdx: tokenStart, query: token.slice(1), type: "style" };
}

interface Props {
  /** Current textarea value. */
  value: string;
  /** Current caret offset (textarea.selectionStart). */
  caret: number;
  /**
   * Called when an item is selected. Receives the rewritten input
   * value + new caret position so the parent can update both.
   */
  onCommit: (rewritten: { value: string; caret: number; item: MentionItem }) => void;
  /** Called when Esc is pressed inside the dropdown — hides it. */
  onCancel: () => void;
  /**
   * Forwarded keyboard events from the textarea. The dropdown handles
   * ↑/↓/Enter/Tab/Esc when it's visible; returns true if handled so
   * the parent can prevent its own default (e.g. Enter = send).
   */
  registerKeyHandler: (handler: ((e: React.KeyboardEvent) => boolean) | null) => void;
}

/**
 * Inline floating dropdown rendered below the textarea. Re-fetches
 * suggestions when the trigger query changes (debounced ~120ms).
 */
export function MentionAutocomplete({ value, caret, onCommit, onCancel, registerKeyHandler }: Props) {
  const trigger = useMemo(() => {
    const t = parseTrigger(value, caret) || parseStyleTrigger(value, caret);
    return t;
  }, [value, caret]);

  const [items, setItems] = useState<MentionItem[]>([]);
  const [highlighted, setHighlighted] = useState(0);
  const [loading, setLoading] = useState(false);
  const reqIdRef = useRef(0);

  // Debounced fetch when the query changes.
  useEffect(() => {
    if (!trigger) { setItems([]); return; }
    const id = ++reqIdRef.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const url = `/api/internal/ai/mention-suggest?type=${encodeURIComponent(trigger.type)}&q=${encodeURIComponent(trigger.query)}`;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (id !== reqIdRef.current) return; // stale request
        const list: MentionItem[] = Array.isArray(j.items)
          ? j.items.map((x: { id: string; label: string; sublabel: string }) => ({ ...x, type: trigger.type }))
          : [];
        setItems(list);
        setHighlighted(0);
      } catch {
        if (id === reqIdRef.current) setItems([]);
      } finally {
        if (id === reqIdRef.current) setLoading(false);
      }
    }, 120);
    return () => clearTimeout(t);
  }, [trigger?.type, trigger?.query]);

  // Commit selection: rewrite the input value so the @query is
  // replaced with a clean labelled token (`@Burlington_Coat_Factory`).
  // The panel keeps a parallel map of token → resolved id so the
  // server gets a question that already names the entity by id (e.g.
  // "@Burlington_Coat_Factory (customer_id=abc123)") and can skip the
  // find_customer round-trip + Xoro-drift resolution.
  function commit(item: MentionItem) {
    if (!trigger) return;
    const before = value.slice(0, trigger.startIdx);
    const after  = value.slice(caret);
    const sigil  = trigger.type === "customer" ? "@" : "#";
    const tokenLabel = item.label.replace(/\s+/g, "_");
    const inserted = `${sigil}${tokenLabel} `;
    const next = before + inserted + after;
    const newCaret = (before + inserted).length;
    onCommit({ value: next, caret: newCaret, item });
  }

  // Register a keyboard handler with the parent so the textarea's
  // own onKeyDown can defer to us when the dropdown is open.
  useEffect(() => {
    if (!trigger || items.length === 0) {
      registerKeyHandler(null);
      return;
    }
    const handler = (e: React.KeyboardEvent): boolean => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlighted(h => (h + 1) % items.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlighted(h => (h - 1 + items.length) % items.length);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        commit(items[highlighted]);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return true;
      }
      return false;
    };
    registerKeyHandler(handler);
    return () => registerKeyHandler(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger?.startIdx, items.length, highlighted]);

  if (!trigger) return null;
  if (!loading && items.length === 0 && trigger.query.length === 0) return null;

  return (
    <div style={panelStyle}>
      {loading && items.length === 0 ? (
        <div style={{ padding: "8px 10px", color: "#94A3B8", fontSize: 11 }}>Searching…</div>
      ) : items.length === 0 ? (
        <div style={{ padding: "8px 10px", color: "#94A3B8", fontSize: 11 }}>No matches.</div>
      ) : (
        items.map((it, i) => (
          <button
            key={`${it.type}:${it.id}`}
            type="button"
            onClick={() => commit(it)}
            onMouseEnter={() => setHighlighted(i)}
            style={{
              ...rowStyle,
              background: i === highlighted ? "#1E40AF" : "transparent",
              color: i === highlighted ? "#fff" : "#E2E8F0",
            }}
          >
            <span style={{ fontWeight: 600 }}>{it.label}</span>
            <span style={{ fontSize: 10, color: i === highlighted ? "rgba(255,255,255,0.85)" : "#94A3B8" }}>
              {it.sublabel}
            </span>
          </button>
        ))
      )}
    </div>
  );
}

// ── styles ──────────────────────────────────────────────────────────────
const panelStyle: React.CSSProperties = {
  position: "absolute", bottom: "100%", left: 0, right: 0,
  background: "#0F172A", border: "1px solid #334155",
  borderRadius: 8, marginBottom: 6, maxHeight: 220, overflowY: "auto",
  boxShadow: "0 -6px 16px rgba(0,0,0,0.3)", zIndex: 10,
  display: "flex", flexDirection: "column",
};
const rowStyle: React.CSSProperties = {
  display: "flex", justifyContent: "space-between", alignItems: "center",
  padding: "8px 10px", border: "none", borderRadius: 0, textAlign: "left",
  cursor: "pointer", fontSize: 12, fontFamily: "inherit",
};
