import React, { useEffect, useRef, useState } from "react";
import {
  applyAction,
  applySuggestion,
  describeAction,
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
  // Dim trace of server-side DB tool calls (find_customer / query_*),
  // shown under the reply so operators can see what was looked up.
  trace?: ToolTraceEntry[];
  pending?: boolean;
  error?: boolean;
}

const DEFAULT_SAMPLES = [
  "Show me only Mens",
  "Filter to category Tops",
  "Sort by on-order descending",
  "What's the total on-order value?",
  "How many Edge did Ross order June 2026 vs ship same period last year?",
  "Clear all filters",
];

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

export const AskAIPanel: React.FC<AskAIPanelProps> = ({
  open, onClose, buildContext, setters, samplePrompts,
}) => {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

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
      const resp = await fetch("/api/ai/ask-grid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmed, history, grid_context: context }),
      });
      const body: AskAIResponse & { error?: string } = await resp.json().catch(() => ({} as AskAIResponse & { error?: string }));
      if (!resp.ok) {
        const errMsg = body?.error || `HTTP ${resp.status}`;
        setMessages(prev => prev.map(m => m.id === pendingMsg.id ? {
          ...m, pending: false, error: true, text: `Error: ${errMsg}`,
        } : m));
        return;
      }

      const actions: AIAction[] = Array.isArray(body.actions) ? body.actions : [];
      for (const action of actions) {
        try { applyAction(action, setters); }
        catch (err) { console.warn("[AskAI] applyAction failed", err); }
      }
      const actionLabel = actions.length > 0 ? actions.map(describeAction).join(" · ") : undefined;
      const finalText = body.text?.trim() || (actionLabel ? "Done." : "(no response)");
      setMessages(prev => prev.map(m => m.id === pendingMsg.id ? {
        ...m, pending: false, text: finalText, actionLabel,
        suggestion: body.suggestion ?? null,
        trace: Array.isArray(body.trace) ? body.trace : undefined,
      } : m));
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

  const samples = samplePrompts && samplePrompts.length > 0 ? samplePrompts : DEFAULT_SAMPLES;

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
              <div style={{ fontSize: 11, color: "#64748B" }}>Ask about the grid, or tell it what to filter</div>
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
              <div style={{ marginBottom: 10 }}>Try one of these:</div>
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
                lineHeight: 1.4,
                whiteSpace: "pre-wrap",
                opacity: m.pending ? 0.7 : 1,
              }}
            >
              {m.text}
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
              {m.suggestion && !m.suggestionPushed && (
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
              {m.trace && m.trace.length > 0 && (
                <div style={{
                  marginTop: 8,
                  paddingTop: 6,
                  borderTop: "1px dashed rgba(148,163,184,0.25)",
                  fontSize: 10,
                  color: "#64748B",
                  fontFamily: "ui-monospace, SFMono-Regular, monospace",
                  lineHeight: 1.4,
                }}>
                  {m.trace.map((t, i) => (
                    <div key={i}>· {t.summary}</div>
                  ))}
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
              placeholder="Ask anything about the grid…"
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
