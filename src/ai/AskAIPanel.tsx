import React, { useEffect, useRef, useState } from "react";
import {
  applyAction,
  applySuggestion,
  describeAction,
  fetchPopularPrompts,
  type AIAction,
  type AIGridSetters,
  type AskAIHistoryTurn,
  type AskAIResponse,
  type GridContextSnapshot,
  type GridSuggestion,
  type ToolTraceEntry,
} from "./tools";

// Slide-in chat panel anchored to the right edge. Built as a standalone
// component so any grid (ATS today, others later) can drop it in by
// supplying a buildContext() closure and the setter bundle.

interface AskAIPanelProps {
  open: boolean;
  onClose: () => void;
  // Called every time the user hits Send. Snapshot is captured fresh so
  // the AI sees the live filter/sort state, not stale render-time data.
  buildContext: () => GridContextSnapshot;
  setters: AIGridSetters;
  // Sample prompts shown above the input on first open. Caller can
  // tailor them per-grid (ATS vs SO vs PO etc.).
  samplePrompts?: string[];
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  actionLabel?: string;
  // Pending suggestion the user can opt into. Cleared once they push.
  suggestion?: GridSuggestion | null;
  suggestionPushed?: boolean;
  // 1-3 follow-up question strings the model proposed. Rendered as
  // clickable chips below the bubble; clicking one fires send().
  // Cleared once a chip is clicked OR the next assistant turn lands
  // (we only want chips on the LAST assistant message).
  followups?: string[];
  // Dim trace of server-side DB tool calls (find_customer / query_*),
  // shown under the reply so operators can see what was looked up.
  trace?: ToolTraceEntry[];
  pending?: boolean;
  error?: boolean;
  // Cache hit metadata — surfaced as a small "cached Xm ago · Ask fresh ↻"
  // hint below the bubble so operators know the answer might be stale
  // and can re-ask to force a fresh run.
  cached?: boolean;
  cachedAgeSeconds?: number;
}

function formatAge(seconds: number): string {
  if (seconds < 60)   return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

const DEFAULT_SAMPLES = [
  "Show me only Mens",
  "Sort by on-order descending",
  "How many Edge did Ross order June 2026 vs ship same period last year?",
  "What compliance docs expire in the next 30 days?",
  "Open AR by status — sum total per status",
  "Which vendors had the most disputes this quarter?",
  "Forecast accuracy MAPE by method last quarter",
  "Clear all filters",
];

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

// Minimal markdown-to-React renderer. The system prompt restricts Claude
// to plain prose + **bold**, so we only need to handle that one inline
// token. Anything else passes through as literal text. Keeps the bundle
// tiny vs pulling in react-markdown.
function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const open = text.indexOf("**", i);
    if (open === -1) { parts.push(text.slice(i)); break; }
    const close = text.indexOf("**", open + 2);
    if (close === -1) { parts.push(text.slice(i)); break; }
    if (open > i) parts.push(text.slice(i, open));
    parts.push(<strong key={key++} style={{ color: "#F1F5F9" }}>{text.slice(open + 2, close)}</strong>);
    i = close + 2;
  }
  return parts;
}

function RenderedMessage({ text }: { text: string }) {
  // Split on blank lines to give each paragraph its own block. Inside a
  // paragraph, single newlines are preserved (whiteSpace: pre-wrap on the
  // outer bubble would handle it, but paragraphs read cleaner with
  // explicit spacing).
  const paragraphs = text.split(/\n{2,}/);
  return (
    <>
      {paragraphs.map((para, idx) => (
        <div key={idx} style={{ marginTop: idx === 0 ? 0 : 8, whiteSpace: "pre-wrap" }}>
          {renderInline(para)}
        </div>
      ))}
    </>
  );
}

export const AskAIPanel: React.FC<AskAIPanelProps> = ({
  open, onClose, buildContext, setters, samplePrompts,
}) => {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  // Operator-asked popular prompts loaded once per panel session.
  // Empty array = "not loaded / nothing to show", in which case we
  // fall back to the static samplePrompts prop.
  const [popularPrompts, setPopularPrompts] = useState<string[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Tier 1C: fetch the top N most-hit questions from the answer cache
  // when the panel first opens. We don't refetch on every open — the
  // popularity list barely moves between opens, and a stale list is
  // strictly better than the static defaults. Fires once per mount.
  useEffect(() => {
    if (!open || popularPrompts.length > 0) return;
    let cancelled = false;
    fetchPopularPrompts({ limit: 8 })
      .then(rows => { if (!cancelled) setPopularPrompts(rows); })
      .catch(() => { /* swallow — falls back to static prompts */ });
    return () => { cancelled = true; };
  }, [open, popularPrompts.length]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;

    const userMsg: ChatMessage = { id: genId(), role: "user", text: trimmed };
    const pendingMsg: ChatMessage = { id: genId(), role: "assistant", text: "Thinking…", pending: true };
    setMessages(prev => [...prev, userMsg, pendingMsg]);
    setInput("");
    setBusy(true);

    // History sent to the server: every prior user/assistant pair, no
    // pending/system entries. Cap is enforced server-side too.
    const history: AskAIHistoryTurn[] = messages
      .filter(m => (m.role === "user" || m.role === "assistant") && !m.pending && !m.error)
      .map(m => ({ role: m.role as "user" | "assistant", text: m.text }));

    let context: GridContextSnapshot;
    try {
      context = buildContext();
    } catch (err) {
      setMessages(prev => prev.map(m => m.id === pendingMsg.id ? {
        ...m, pending: false, error: true, text: `Failed to snapshot grid context: ${String((err as Error).message || err)}`,
      } : m));
      setBusy(false);
      return;
    }

    try {
      // SSE stream — opt in via Accept header. Server emits stage labels,
      // text deltas, and a terminal complete event. No bearer needed (the
      // server gates on same-origin + budget cap).
      const resp = await fetch("/api/ai/ask-grid", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
        body: JSON.stringify({ question: trimmed, history, grid_context: context }),
      });
      if (!resp.ok || !resp.body) {
        let errMsg = `HTTP ${resp.status}`;
        try { const j = await resp.json(); if (j?.error) errMsg = j.error; } catch {}
        setMessages(prev => prev.map(m => m.id === pendingMsg.id ? {
          ...m, pending: false, error: true, text: `Error: ${errMsg}`,
        } : m));
        return;
      }

      // Iterate the SSE stream. Each `\n\n` separates an event. Events
      // look like:
      //   event: stage\n
      //   data: {"label":"Searching customers…"}\n
      //   \n
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let streamedText = "";
      let stage = "Thinking…";
      let done = false;
      let finalPayload: AskAIResponse | null = null;
      let errorPayload: string | null = null;

      // First flip the pending bubble out of "Thinking…" mode so live
      // updates render in the normal styling.
      setMessages(prev => prev.map(m => m.id === pendingMsg.id ? {
        ...m, pending: false, text: stage,
      } : m));

      const processEvent = (raw: string) => {
        let evt = "message";
        const dataLines: string[] = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) evt = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) return;
        let payload: any;
        try { payload = JSON.parse(dataLines.join("\n")); } catch { return; }

        if (evt === "stage") {
          stage = String(payload.label || "");
          if (!streamedText) {
            setMessages(prev => prev.map(m => m.id === pendingMsg.id ? {
              ...m, text: stage,
            } : m));
          }
        } else if (evt === "text_delta") {
          streamedText += String(payload.text || "");
          setMessages(prev => prev.map(m => m.id === pendingMsg.id ? {
            ...m, text: streamedText,
          } : m));
        } else if (evt === "complete") {
          finalPayload = payload;
          done = true;
        } else if (evt === "error") {
          errorPayload = String(payload.error || "Unknown error");
          done = true;
        }
      };

      while (!done) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buf += decoder.decode(value, { stream: true });

        let eventEnd;
        while ((eventEnd = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, eventEnd);
          buf = buf.slice(eventEnd + 2);
          processEvent(raw);
          if (done) break;
        }
      }
      // Flush any trailing decoder state + parse a final un-terminated
      // event if the network dropped the closing newlines. Without this
      // the `complete` payload could be silently lost and the bubble
      // would render "(no response)" despite valid server output.
      buf += decoder.decode();
      if (!done && buf.trim().length > 0) {
        processEvent(buf.trim());
      }

      if (errorPayload) {
        setMessages(prev => prev.map(m => m.id === pendingMsg.id ? {
          ...m, pending: false, error: true, text: `Error: ${errorPayload}`,
        } : m));
        return;
      }

      const actions: AIAction[] = Array.isArray(finalPayload?.actions) ? finalPayload!.actions : [];
      // Only apply + label actions when the host actually wired setters.
      // Mounts in PO WIP / Design Calendar / Planning pass `{}` because
      // their state shapes don't match the AI's grid-filter tools; for
      // those apps actions are no-ops and would otherwise show a
      // misleading "Applied filters: …" footnote.
      const hasSetters = setters && Object.keys(setters).length > 0;
      if (hasSetters) {
        for (const action of actions) {
          try { applyAction(action, setters); }
          catch (err) { console.warn("[AskAI] applyAction failed", err); }
        }
      }
      const actionLabel = hasSetters && actions.length > 0
        ? actions.map(describeAction).join(" · ")
        : undefined;
      const finalText = (finalPayload?.text || streamedText || "").trim() || (actionLabel ? "Done." : "(no response)");
      const followups = Array.isArray(finalPayload?.followups)
        ? (finalPayload!.followups as string[]).filter(q => typeof q === "string" && q.trim().length > 0).slice(0, 3)
        : undefined;
      setMessages(prev => prev.map(m => {
        if (m.id !== pendingMsg.id) {
          // Strip followups from any prior assistant message — chips
          // only belong on the LATEST reply, otherwise the operator
          // accumulates dead chips up the scroll.
          if (m.role === "assistant" && m.followups) {
            return { ...m, followups: undefined };
          }
          return m;
        }
        return {
          ...m, pending: false, text: finalText, actionLabel,
          suggestion: finalPayload?.suggestion ?? null,
          followups: followups && followups.length > 0 ? followups : undefined,
          trace: Array.isArray(finalPayload?.trace) ? finalPayload!.trace : undefined,
          cached: !!finalPayload?.cached,
          cachedAgeSeconds: typeof finalPayload?.cached_age_seconds === "number" ? finalPayload!.cached_age_seconds : undefined,
        };
      }));
    } catch (err) {
      setMessages(prev => prev.map(m => m.id === pendingMsg.id ? {
        ...m, pending: false, error: true, text: `Network error: ${String((err as Error).message || err)}`,
      } : m));
    } finally {
      setBusy(false);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input);
    } else if (e.key === "Escape") {
      onClose();
    }
  }

  if (!open) return null;

  // Prefer real operator-asked popular questions when we have at least 3
  // (below 3 the list looks thin/empty); fall back to the host-provided
  // per-app prompts (App.tsx, TandA.tsx, PlanningShell.tsx), then to
  // DEFAULT_SAMPLES if no host prompts wired.
  const samples = popularPrompts.length >= 3
    ? popularPrompts
    : (samplePrompts && samplePrompts.length > 0 ? samplePrompts : DEFAULT_SAMPLES);
  const samplesAreFromPopular = popularPrompts.length >= 3;

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 500,
        }}
      />
      <div
        style={{
          position: "fixed",
          top: 0, right: 0, bottom: 0,
          width: 440, maxWidth: "92vw",
          background: "#0F172A",
          borderLeft: "1px solid #1E293B",
          boxShadow: "-8px 0 24px rgba(0,0,0,0.4)",
          zIndex: 501,
          display: "flex", flexDirection: "column",
          color: "#F1F5F9",
          fontFamily: "inherit",
        }}
      >
        <div style={{
          padding: "12px 16px",
          borderBottom: "1px solid #1E293B",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          background: "linear-gradient(180deg, #1E293B 0%, #0F172A 100%)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 18 }}>✨</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: "#F1F5F9" }}>Ask Claude</div>
              <div style={{ fontSize: 11, color: "#64748B" }}>Ask me anything ROF related</div>
            </div>
          </div>
          <button
            onClick={onClose}
            title="Close"
            style={{
              background: "transparent", border: "none", color: "#94A3B8",
              cursor: "pointer", fontSize: 20, padding: "0 6px",
            }}
          >×</button>
        </div>

        <div
          ref={scrollRef}
          style={{
            flex: 1, overflowY: "auto", padding: 16,
            display: "flex", flexDirection: "column", gap: 12,
          }}
        >
          {messages.length === 0 && (
            <div style={{ color: "#94A3B8", fontSize: 13 }}>
              <div style={{ marginBottom: 10 }}>
                {samplesAreFromPopular ? "Most-asked questions:" : "Try one of these:"}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {samples.map(s => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    disabled={busy}
                    style={{
                      textAlign: "left",
                      background: "#1E293B",
                      border: "1px solid #334155",
                      color: "#E2E8F0",
                      borderRadius: 8,
                      padding: "8px 12px",
                      fontSize: 13,
                      cursor: busy ? "not-allowed" : "pointer",
                      fontFamily: "inherit",
                    }}
                    onMouseEnter={e => !busy && (e.currentTarget.style.background = "#334155")}
                    onMouseLeave={e => (e.currentTarget.style.background = "#1E293B")}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map(m => (
            <div
              key={m.id}
              style={{
                alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                maxWidth: "85%",
                background: m.role === "user"
                  ? "#3B82F6"
                  : m.error
                    ? "#7F1D1D"
                    : "#1E293B",
                color: m.role === "user" ? "#fff" : (m.error ? "#FECACA" : "#E2E8F0"),
                padding: "8px 12px",
                borderRadius: 10,
                fontSize: 13,
                lineHeight: 1.5,
                opacity: m.pending ? 0.7 : 1,
              }}
            >
              {m.role === "assistant" && !m.pending && !m.error
                ? <RenderedMessage text={m.text} />
                : <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>}
              {m.actionLabel && (
                <div style={{
                  marginTop: 6,
                  fontSize: 11,
                  color: m.role === "user" ? "rgba(255,255,255,0.85)" : "#6EE7B7",
                  fontStyle: "italic",
                }}>
                  → {m.actionLabel}
                </div>
              )}
              {m.suggestion && !m.suggestionPushed && setters && Object.keys(setters).length > 0 && (
                <button
                  onClick={() => {
                    try { applySuggestion(m.suggestion!, setters); }
                    catch (err) { console.warn("[AskAI] applySuggestion failed", err); }
                    setMessages(prev => prev.map(x => x.id === m.id ? { ...x, suggestionPushed: true } : x));
                  }}
                  style={{
                    marginTop: 8,
                    background: "#10B981",
                    border: "1px solid #047857",
                    color: "#fff",
                    borderRadius: 6,
                    padding: "6px 10px",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  ↳ {m.suggestion.label}
                </button>
              )}
              {m.suggestionPushed && (
                <div style={{ marginTop: 6, fontSize: 11, color: "#6EE7B7", fontStyle: "italic" }}>
                  ✓ Applied to grid
                </div>
              )}
              {/* Follow-up question chips — only on the latest assistant
                  reply (older bubbles get followups stripped on the next
                  turn). Clicking sends the chip text as a new question. */}
              {m.role === "assistant" && m.followups && m.followups.length > 0 && !busy && (
                <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap" as const, gap: 6 }}>
                  {m.followups.map((q, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        // Strip chips from this bubble immediately so a
                        // double-click can't fire twice.
                        setMessages(prev => prev.map(x => x.id === m.id ? { ...x, followups: undefined } : x));
                        send(q);
                      }}
                      style={{
                        background: "#1E293B",
                        border: "1px solid #334155",
                        color: "#93C5FD",
                        borderRadius: 14,
                        padding: "4px 10px",
                        fontSize: 11,
                        fontWeight: 500,
                        cursor: "pointer",
                        fontFamily: "inherit",
                        transition: "background 0.1s, border-color 0.1s",
                      }}
                      onMouseEnter={e => {
                        e.currentTarget.style.background = "#334155";
                        e.currentTarget.style.borderColor = "#475569";
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.background = "#1E293B";
                        e.currentTarget.style.borderColor = "#334155";
                      }}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              )}
              {m.cached && (
                <div style={{ marginTop: 6, fontSize: 10, color: "#94A3B8", fontStyle: "italic", display: "flex", alignItems: "center", gap: 8 }}>
                  <span>⚡ Cached answer{typeof m.cachedAgeSeconds === "number" ? ` · ${formatAge(m.cachedAgeSeconds)} ago` : ""}</span>
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={{
          padding: 12,
          borderTop: "1px solid #1E293B",
          background: "#0F172A",
        }}>
          <div style={{ display: "flex", gap: 8 }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask anything ROF related…"
              rows={2}
              disabled={busy}
              style={{
                flex: 1,
                background: "#1E293B",
                border: "1px solid #334155",
                borderRadius: 8,
                padding: "8px 10px",
                color: "#F1F5F9",
                fontSize: 13,
                fontFamily: "inherit",
                resize: "none",
                outline: "none",
              }}
            />
            <button
              onClick={() => send(input)}
              disabled={busy || !input.trim()}
              style={{
                background: busy || !input.trim() ? "#1E293B" : "#3B82F6",
                color: busy || !input.trim() ? "#64748B" : "#fff",
                border: "none",
                borderRadius: 8,
                padding: "0 14px",
                fontSize: 13,
                fontWeight: 600,
                cursor: busy || !input.trim() ? "not-allowed" : "pointer",
                fontFamily: "inherit",
              }}
            >
              {busy ? "…" : "Send"}
            </button>
          </div>
          <div style={{ marginTop: 6, fontSize: 10, color: "#64748B" }}>
            Enter to send · Shift+Enter for newline · Esc to close
          </div>
        </div>
      </div>
    </>
  );
};
