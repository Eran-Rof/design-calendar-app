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
import { getScreenContext } from "./askAIBridge";
import {
  loadConversation,
  saveConversation,
  clearConversation,
  type StoredChatMessage,
} from "./conversationStore";
import {
  generateMemoryFile,
  downloadMemoryFile,
} from "./memoryFile";
import { MentionAutocomplete, expandMentionsForServer } from "./MentionAutocomplete";
import SearchableSelect from "../tanda/components/SearchableSelect";
import {
  fileToAttachment,
  imagesFromDataTransferItems,
  revokeAttachmentPreviews,
  MAX_ATTACHMENTS_PER_TURN,
  type ImageAttachment,
} from "./imageAttachments";

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
  /** Stable identifier for the host app (e.g. "ats", "po_wip", "dc",
   *  "planning", "tanda"). Used as the localStorage key prefix for
   *  conversation memory (Tier 2E). Omit to disable persistence —
   *  the panel still works exactly the same, conversations just don't
   *  survive close/reopen. */
  appId?: string;
  /** PR 4/4: pre-fill the input from outside (e.g. from a "Ask AI
   *  about this row" right-click). Whenever this prop changes to a
   *  non-empty string, the panel sets its internal input to that
   *  value (operator can edit before sending). Host should null it
   *  out after consumption to allow the same prompt to be sent again. */
  draftInput?: string | null;
  /** Called after the panel adopts `draftInput`, so the host can
   *  reset its state to null. Optional — without it the panel will
   *  ignore a repeated identical draft. */
  onDraftInputConsumed?: () => void;
  /** P28-2: host-provided navigation for the assistant's open_panel
   *  action (Tangerine passes its ?m= module hop). Handled separately
   *  from `setters` — navigation isn't a grid mutation, so it works
   *  even when the host wires no grid setters. */
  onOpenPanel?: (panel: string, q?: string) => void;
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
  // Toggle visibility with the ⓘ "Why?" affordance below the bubble.
  trace?: ToolTraceEntry[];
  /** Per-message expansion state for the "Why?" trace panel. */
  traceExpanded?: boolean;
  /** Tier 3L: capture-as-fact form state on this assistant bubble. */
  captureOpen?: boolean;
  captureTopic?: string;
  captureScope?: "self" | "global";
  captureBusy?: boolean;
  captureError?: string;
  /** Set true after a successful save so the bubble shows the
   *  download affordance + a "captured" badge. */
  factCaptured?: boolean;
  /** Transient state used by the Copy button to flash "Copied" for
   *  ~1.4s after a successful clipboard write. */
  justCopied?: boolean;
  /** Object-URL previews of images attached to this (user) message. */
  attachmentPreviews?: string[];
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
  "Run the Monday briefing",
  "Show me the underperformer review for this quarter",
  "Which customers look like churn risks right now?",
  "What compliance docs expire in the next 30 days?",
  "Open AR by status — sum total per status",
];

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

// Shared style for the per-bubble action links (Copy / Regenerate /
// "Why?"). Subtle by default, lights up on hover.
const bubbleActionStyle: React.CSSProperties = {
  background: "none", border: "none", padding: 0,
  color: "#64748B", fontStyle: "italic",
  fontSize: 10, fontFamily: "inherit",
  cursor: "pointer", transition: "color 0.1s",
};

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
  open, onClose, buildContext, setters, samplePrompts, appId, draftInput, onDraftInputConsumed, onOpenPanel,
}) => {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  // Pop-out mode (PR: bubble-actions). When true the panel renders as
  // a near-full-screen overlay so tables / charts / long answers stop
  // feeling cramped. Persisted per-operator in localStorage so the
  // preference survives reloads.
  const [poppedOut, setPoppedOut] = useState<boolean>(() => {
    try { return localStorage.getItem("ai_panel_popped_out") === "1"; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("ai_panel_popped_out", poppedOut ? "1" : "0"); }
    catch { /* ignore */ }
  }, [poppedOut]);
  // Tier-3L+: per-user-message edit mode. When set to a message id, that
  // bubble renders an inline textarea instead of static text.
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  // @mention dropdown state. caret position is tracked separately —
  // React's onChange doesn't fire on caret-only moves (arrow keys),
  // so we refresh on every interaction the textarea handles.
  const [caret, setCaret] = useState(0);
  const mentionKeyHandlerRef = useRef<((e: React.KeyboardEvent) => boolean) | null>(null);
  // Token → resolved entity map. Keys are the underscore-flattened
  // labels the dropdown inserts (e.g. "Burlington_Coat_Factory");
  // values let `expandMentionsForServer` substitute the id parenthetical
  // before the question hits Claude. Survives across edits but
  // tokens not present in the final text are pruned at send time.
  const mentionMapRef = useRef<Map<string, { id: string; type: "customer" | "style"; label: string }>>(new Map());

  // Vision attachments staged for the NEXT send (P11-vision / PR #218).
  // Cleared after submit OR when removed individually. Object URLs are
  // revoked on unmount + when sent. Capped at MAX_ATTACHMENTS_PER_TURN.
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  // Drag-over visual: lights up the input area when files are dragged over.
  const [dragActive, setDragActive] = useState(false);

  async function addAttachments(files: File[]) {
    if (files.length === 0) return;
    if (attachments.length >= MAX_ATTACHMENTS_PER_TURN) {
      setAttachmentError(`At most ${MAX_ATTACHMENTS_PER_TURN} images per turn.`);
      return;
    }
    const remainingSlots = MAX_ATTACHMENTS_PER_TURN - attachments.length;
    const toProcess = files.slice(0, remainingSlots);
    setAttachmentError(null);
    try {
      const built = await Promise.all(toProcess.map(f => fileToAttachment(f)));
      setAttachments(prev => [...prev, ...built]);
    } catch (e) {
      setAttachmentError(String((e as Error).message || e));
    }
  }

  function removeAttachment(idx: number) {
    setAttachments(prev => {
      const out = prev.slice();
      const removed = out.splice(idx, 1);
      revokeAttachmentPreviews(removed);
      return out;
    });
  }

  // Free any in-flight object URLs on unmount so we don't leak.
  useEffect(() => () => { revokeAttachmentPreviews(attachments); /* eslint-disable-next-line */ }, []);
  // Empty array = "not loaded / nothing to show", in which case we
  // fall back to the static samplePrompts prop.
  const [popularPrompts, setPopularPrompts] = useState<string[]>([]);
  // Resolved operator id for the conversation-memory key. Falls back
  // to "anon" when sessionStorage.plm_user is missing (e.g. dev mode
  // without a login) so persistence still works per-machine.
  const userId = useRef<string>((() => {
    try {
      const raw = sessionStorage.getItem("plm_user");
      if (!raw) return "anon";
      const u = JSON.parse(raw) as { id?: string; name?: string } | null;
      return u?.id || u?.name || "anon";
    } catch { return "anon"; }
  })()).current;
  // Track whether we've already hydrated from localStorage so the
  // first open doesn't trigger a save before we've loaded — that
  // would overwrite the prior conversation with an empty array.
  const hydratedRef = useRef(false);
  // Tier 3K: proactive insights surfaced by api/cron/ai-proactive-insights.
  // Loaded once on first open. Inline panel below the header when expanded.
  const [insights, setInsights] = useState<Array<{ id: string; rule: string; severity: string; headline: string; detail: string | null; subject_label: string | null }>>([]);
  const [insightsLoaded, setInsightsLoaded] = useState(false);
  const [showInsights, setShowInsights] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // PR 4/4: when the host pushes a `draftInput`, adopt it into the
  // textarea and notify the host to clear its state so the same draft
  // can be sent again later. Operator can still edit before sending.
  useEffect(() => {
    if (typeof draftInput === "string" && draftInput.length > 0) {
      setInput(draftInput);
      onDraftInputConsumed?.();
      setTimeout(() => inputRef.current?.focus(), 30);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftInput]);

  // Tier 2E: hydrate prior conversation on first open. Only runs once
  // per panel mount — re-opening the panel during the same mount
  // reuses the in-memory `messages` state.
  useEffect(() => {
    if (!open || hydratedRef.current || !appId) return;
    hydratedRef.current = true;
    const prior = loadConversation(appId, userId);
    if (prior && prior.length > 0) setMessages(prior);
  }, [open, appId, userId]);

  // Tier 2E: persist on every messages change. Skipped until we've
  // hydrated (otherwise the first render writes [] over the stored
  // history). Also skipped when there's no appId (host opted out).
  useEffect(() => {
    if (!appId || !hydratedRef.current) return;
    // Drop any pending / error bubbles before persisting — restoring
    // an "Error: HTTP 500" bubble from yesterday is just noise.
    const toPersist: StoredChatMessage[] = messages
      .filter(m => !m.pending && !m.error)
      .map(m => ({
        id: m.id,
        role: m.role,
        text: m.text,
        ...(m.actionLabel        ? { actionLabel: m.actionLabel }             : {}),
        ...(m.suggestionPushed   ? { suggestionPushed: m.suggestionPushed }   : {}),
        ...(m.cached             ? { cached: m.cached }                       : {}),
        ...(typeof m.cachedAgeSeconds === "number"
          ? { cachedAgeSeconds: m.cachedAgeSeconds }
          : {}),
      }));
    saveConversation(appId, userId, toPersist);
  }, [messages, appId, userId]);

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

  // Tier 3K: fetch open proactive insights on first panel open. Same
  // fire-once-per-mount pattern as popularPrompts so we don't hammer
  // the API on every reopen.
  useEffect(() => {
    if (!open || insightsLoaded) return;
    let cancelled = false;
    fetch("/api/internal/ai/insights")
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (cancelled || !j) return;
        setInsights(Array.isArray(j.insights) ? j.insights : []);
        setInsightsLoaded(true);
      })
      .catch(() => { setInsightsLoaded(true); /* swallow — pill hides */ });
    return () => { cancelled = true; };
  }, [open, insightsLoaded]);

  async function dismissInsight(id: string) {
    try {
      await fetch(`/api/internal/ai/insights?id=${encodeURIComponent(id)}&action=dismiss`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
      });
      setInsights(prev => prev.filter(i => i.id !== id));
    } catch { /* keep showing — operator can retry */ }
  }

  // Tier 3L: capture an assistant message as an operator-authored fact.
  // POSTs to /api/internal/ai/user-facts (Tier 2H endpoint) so the same
  // body the operator just read is reusable by future AI sessions; on
  // success offers a memory-tree .md download so the same fact also
  // lives client-side for Claude Code.
  async function captureMessageAsFact(messageId: string) {
    const m = messages.find(x => x.id === messageId);
    if (!m) return;
    const topic = (m.captureTopic || "").trim();
    if (!topic) {
      setMessages(prev => prev.map(x => x.id === messageId ? { ...x, captureError: "Topic is required." } : x));
      return;
    }
    setMessages(prev => prev.map(x => x.id === messageId ? { ...x, captureBusy: true, captureError: undefined } : x));
    try {
      const body = {
        topic,
        fact: m.text,
        scope: m.captureScope || "self",
        app: appId || null,
        user_id: userId,
      };
      const r = await fetch("/api/internal/ai/user-facts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setMessages(prev => prev.map(x => x.id === messageId ? {
        ...x, captureBusy: false, captureOpen: false, factCaptured: true,
      } : x));
    } catch (e) {
      setMessages(prev => prev.map(x => x.id === messageId ? {
        ...x, captureBusy: false, captureError: String((e as Error).message || e),
      } : x));
    }
  }

  function downloadMessageAsMemoryFile(messageId: string) {
    const m = messages.find(x => x.id === messageId);
    if (!m) return;
    const topic = (m.captureTopic || "").trim() || "ask_ai_fact";
    try {
      const file = generateMemoryFile({
        topic,
        fact: m.text,
        scope: m.captureScope || "self",
        app: appId || null,
        createdBy: userId,
      });
      downloadMemoryFile(file);
    } catch (e) {
      setMessages(prev => prev.map(x => x.id === messageId ? {
        ...x, captureError: String((e as Error).message || e),
      } : x));
    }
  }

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  /**
   * send(text) — operator-facing: append a user message + stream a reply.
   *
   * `opts.baseMessages` lets regenerate / edit-and-resend pass an
   * explicitly-truncated message list (the React state closure for
   * `messages` is the wrong source after we've just truncated). When
   * provided, `text` is treated as the question for an EXISTING user
   * message already at the tail of `baseMessages` — we do NOT append a
   * new one.
   */
  async function send(text: string, opts?: { baseMessages?: ChatMessage[] }) {
    const trimmed = text.trim();
    // Vision (PR #218): allow an image-only turn (no text) to send with a
    // sensible default question. Attachments only apply to a fresh turn,
    // not to a history-replay (opts.baseMessages).
    const hasAttachments = !opts?.baseMessages && attachments.length > 0;
    if (busy) return;
    if (!trimmed && !hasAttachments) return;
    const effectiveText = trimmed || (hasAttachments ? "What's in this image?" : "");
    const sendAttachments = hasAttachments ? attachments : [];
    if (hasAttachments) { setAttachments([]); setAttachmentError(null); }

    let baseMessages: ChatMessage[];
    if (opts?.baseMessages) {
      baseMessages = opts.baseMessages;
    } else {
      const userMsg: ChatMessage = {
        id: genId(), role: "user", text: effectiveText,
        ...(sendAttachments.length > 0 ? { attachmentPreviews: sendAttachments.map(a => a.previewUrl) } : {}),
      };
      baseMessages = [...messages, userMsg];
    }
    const pendingMsg: ChatMessage = { id: genId(), role: "assistant", text: "Thinking…", pending: true };
    setMessages([...baseMessages, pendingMsg]);
    if (!opts?.baseMessages) setInput("");
    setBusy(true);

    // History sent to the server: every prior user/assistant pair, no
    // pending/system entries, AND excluding the trigger user message
    // (we send that as the current question). Cap is enforced server-side too.
    const triggerUserId = baseMessages[baseMessages.length - 1]?.id;
    const history: AskAIHistoryTurn[] = baseMessages
      .filter(m => (m.role === "user" || m.role === "assistant") && !m.pending && !m.error && m.id !== triggerUserId)
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
      // Expand @ / # mentions to id parentheticals for the server only —
      // the displayed user bubble keeps the clean `@Burlington` token.
      // The AI sees "@Burlington (customer_id=abc123)" and uses the
      // resolved id directly instead of round-tripping through find_customer.
      const expandedQuestion = expandMentionsForServer(effectiveText, mentionMapRef.current);
      const expandedHistory = history.map(h =>
        h.role === "user" ? { ...h, text: expandMentionsForServer(h.text, mentionMapRef.current) } : h,
      );
      const resp = await fetch("/api/ai/ask-grid", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
        body: JSON.stringify({
          question: expandedQuestion,
          history: expandedHistory,
          grid_context: context,
          // Forwarded so the server can scope lookup_user_facts (Tier 2H)
          // to this operator + app. Server intentionally does NOT trust
          // the AI with user_id — it's a request body field, not a tool
          // parameter.
          user_id: userId,
          app_id: appId || null,
          // P28-3 companion mode: what the operator is looking at right
          // now (published by the host shell / panels via askAIBridge).
          screen_context: getScreenContext(),
          // Vision (PR #218): only present on a turn with staged images.
          ...(sendAttachments.length > 0
            ? { attachments: sendAttachments.map(a => ({ media_type: a.media_type, data: a.data })) }
            : {}),
        }),
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
      // P28-2: open_panel is navigation, not a grid mutation — dispatch it
      // through the host's onOpenPanel regardless of grid setters.
      const navActions = actions.filter(a => a.type === "open_panel");
      const gridActions = actions.filter(a => a.type !== "open_panel");
      if (onOpenPanel) {
        for (const nav of navActions) {
          const panel = typeof nav.params?.panel === "string" ? nav.params.panel : "";
          const q = typeof nav.params?.q === "string" ? nav.params.q : undefined;
          if (panel) {
            try { onOpenPanel(panel, q); }
            catch (err) { console.warn("[AskAI] onOpenPanel failed", err); }
          }
        }
      }
      if (hasSetters) {
        for (const action of gridActions) {
          try { applyAction(action, setters); }
          catch (err) { console.warn("[AskAI] applyAction failed", err); }
        }
      }
      const labelled = [
        ...(onOpenPanel ? navActions : []),
        ...(hasSetters ? gridActions : []),
      ];
      const actionLabel = labelled.length > 0
        ? labelled.map(describeAction).join(" · ")
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

  /**
   * regenerate(assistantId) — re-fire the user prompt that produced
   * `assistantId`. Drops the assistant message + everything after, then
   * re-asks. Vanilla-Claude muscle memory: "didn't like that answer."
   */
  function regenerate(assistantId: string) {
    if (busy) return;
    const idx = messages.findIndex(m => m.id === assistantId);
    if (idx <= 0) return;
    const trigger = messages[idx - 1];
    if (!trigger || trigger.role !== "user") return;
    // Keep up to and INCLUDING the triggering user message.
    const baseMessages = messages.slice(0, idx);
    send(trigger.text, { baseMessages });
  }

  /**
   * editAndResend(userId, newText) — replace the text of an existing
   * user message, drop everything after it, and re-ask. Lets the
   * operator refine a question without re-typing the whole thread.
   */
  function editAndResend(userId: string, newText: string) {
    if (busy) return;
    const trimmed = newText.trim();
    if (!trimmed) return;
    const idx = messages.findIndex(m => m.id === userId);
    if (idx < 0) return;
    const updatedUser: ChatMessage = { ...messages[idx], text: trimmed };
    const baseMessages = [...messages.slice(0, idx), updatedUser];
    setEditingUserId(null);
    setEditingDraft("");
    send(trimmed, { baseMessages });
  }

  /**
   * copyMessage(text) — write to clipboard with a graceful fallback for
   * older browsers / Safari quirks. No toast UI; the button label
   * briefly flips to "Copied" via the bubble's transient state.
   */
  async function copyMessage(messageId: string, text: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for old browsers / non-https origins.
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      // Flash the bubble's local "copied" flag for 1.4s.
      setMessages(prev => prev.map(m => m.id === messageId ? { ...m, justCopied: true } : m));
      setTimeout(() => {
        setMessages(prev => prev.map(m => m.id === messageId ? { ...m, justCopied: false } : m));
      }, 1400);
    } catch {
      /* swallow — the user can select+copy manually */
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
        style={poppedOut ? {
          // Pop-out: near-full-screen overlay with margin breathing room
          // so tables / multi-paragraph answers / future image/chart
          // attachments stop feeling cramped.
          position: "fixed",
          top: 24, right: 24, bottom: 24, left: 24,
          background: "#0F172A",
          border: "1px solid #1E293B",
          borderRadius: 12,
          boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
          zIndex: 501,
          display: "flex", flexDirection: "column",
          color: "#F1F5F9",
          fontFamily: "inherit",
        } : {
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
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: "#F1F5F9" }}>Ask Claude</div>
              <div style={{ fontSize: 11, color: "#64748B" }}>Ask me anything ROF related</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {/* Clear conversation — only shown when there's something to clear
                AND persistence is wired (appId provided). Wipes both the
                in-memory state and the localStorage entry so the operator
                can deliberately reset context. Tier 2E. */}
            {appId && messages.length > 0 && (
              <button
                onClick={() => {
                  if (busy) return;
                  setMessages([]);
                  clearConversation(appId, userId);
                  setTimeout(() => inputRef.current?.focus(), 30);
                }}
                title="Clear conversation"
                disabled={busy}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#64748B",
                  cursor: busy ? "not-allowed" : "pointer",
                  fontSize: 11,
                  padding: "0 8px",
                  fontFamily: "inherit",
                  fontWeight: 500,
                  opacity: busy ? 0.4 : 1,
                  transition: "color 0.1s",
                }}
                onMouseEnter={e => { if (!busy) e.currentTarget.style.color = "#94A3B8"; }}
                onMouseLeave={e => { e.currentTarget.style.color = "#64748B"; }}
              >
                Clear
              </button>
            )}
            {/* Tier 3K: proactive insights pill. Hidden when there are
                none open or the fetch hasn't completed. Click toggles
                the inline list. */}
            {insights.length > 0 && (
              <button
                onClick={() => setShowInsights(v => !v)}
                title={`${insights.length} proactive insight${insights.length === 1 ? "" : "s"} from the nightly scan`}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  background: showInsights ? "#F59E0B" : "transparent",
                  border: `1px solid #F59E0B`, borderRadius: 12,
                  color: showInsights ? "#0F172A" : "#F59E0B",
                  cursor: "pointer", fontSize: 11, fontWeight: 700,
                  padding: "2px 8px", marginRight: 4, fontFamily: "inherit",
                }}
              >
                Insights {insights.length}
              </button>
            )}
            {/* Discoverable link to the operator-facts admin (Tier 2H).
                Opens in a new tab so the operator doesn't lose their
                in-flight Ask AI conversation. */}
            {/* Observability dashboard — token spend, error rate, cache
                hits, most-asked questions. Internal-staff only. */}
            <a
              href="/ai-ops"
              target="_blank"
              rel="noreferrer"
              title="Cost + error + cache telemetry for Ask AI"
              style={{
                color: "#64748B", textDecoration: "none",
                fontSize: 11, padding: "0 8px", fontWeight: 500,
              }}
              onMouseEnter={e => { e.currentTarget.style.color = "#94A3B8"; }}
              onMouseLeave={e => { e.currentTarget.style.color = "#64748B"; }}
            >
              Ops
            </a>
            {/* Discoverable link to saved workflow documents (Tier 3J).
                New tab so an in-flight conversation isn't lost. */}
            <a
              href="/ai-documents"
              target="_blank"
              rel="noreferrer"
              title="Saved workflow documents (re-render against live data)"
              style={{
                color: "#64748B", textDecoration: "none",
                fontSize: 11, padding: "0 8px", fontWeight: 500,
              }}
              onMouseEnter={e => { e.currentTarget.style.color = "#94A3B8"; }}
              onMouseLeave={e => { e.currentTarget.style.color = "#64748B"; }}
            >
              Docs
            </a>
            <a
              href="/ai-facts"
              target="_blank"
              rel="noreferrer"
              title="Manage operator facts the AI consults"
              style={{
                color: "#64748B", textDecoration: "none",
                fontSize: 11, padding: "0 8px", fontWeight: 500,
              }}
              onMouseEnter={e => { e.currentTarget.style.color = "#94A3B8"; }}
              onMouseLeave={e => { e.currentTarget.style.color = "#64748B"; }}
            >
              Facts
            </a>
            {/* Pop-out toggle. Switches the panel between right-anchored
                slim mode and near-full-screen overlay. Preference is
                persisted in localStorage so it survives reload. */}
            <button
              onClick={() => setPoppedOut(v => !v)}
              title={poppedOut ? "Collapse to side panel" : "Expand to full screen"}
              style={{
                background: "transparent", border: "none", color: "#94A3B8",
                cursor: "pointer", fontSize: 14, padding: "0 6px",
              }}
            >{poppedOut ? "⇲" : "⇱"}</button>
            <button
              onClick={onClose}
              title="Close"
              style={{
                background: "transparent", border: "none", color: "#94A3B8",
                cursor: "pointer", fontSize: 20, padding: "0 6px",
              }}
            >×</button>
          </div>
        </div>

        {/* Tier 3K: inline proactive-insights panel, shown when the 💡
            pill in the header is toggled on. Each insight gets a one-
            click "Ask about this" (drops into the input) plus a "Dismiss". */}
        {showInsights && insights.length > 0 && (
          <div style={{
            borderBottom: "1px solid #1E293B", background: "#0B1426",
            padding: "10px 14px", maxHeight: 240, overflowY: "auto",
            display: "flex", flexDirection: "column", gap: 8,
          }}>
            {insights.map(i => (
              <div key={i.id} style={{
                background: "#162033", border: `1px solid ${i.severity === "urgent" ? "#EF4444" : i.severity === "warn" ? "#F59E0B" : "#334155"}`,
                borderRadius: 6, padding: "8px 10px",
              }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
                  <span style={{
                    fontSize: 9, fontWeight: 700, color: "#fff",
                    background: i.severity === "urgent" ? "#EF4444" : i.severity === "warn" ? "#F59E0B" : "#3B82F6",
                    borderRadius: 4, padding: "1px 6px", textTransform: "uppercase", letterSpacing: 0.5,
                  }}>{i.severity}</span>
                  <span style={{ color: "#F1F5F9", fontSize: 12, fontWeight: 600, flex: 1 }}>{i.headline}</span>
                </div>
                {i.detail && <div style={{ color: "#94A3B8", fontSize: 11, marginBottom: 6 }}>{i.detail}</div>}
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    onClick={() => {
                      const subject = i.subject_label || "this";
                      setInput(`Tell me more about ${subject} — ${i.headline}`);
                      setShowInsights(false);
                      setTimeout(() => inputRef.current?.focus(), 30);
                    }}
                    style={{
                      background: "transparent", border: "1px solid #3B82F6", color: "#60A5FA",
                      borderRadius: 4, padding: "2px 8px", fontSize: 10, cursor: "pointer", fontFamily: "inherit",
                    }}
                  >Ask about this</button>
                  <button
                    onClick={() => dismissInsight(i.id)}
                    style={{
                      background: "transparent", border: "1px solid #334155", color: "#94A3B8",
                      borderRadius: 4, padding: "2px 8px", fontSize: 10, cursor: "pointer", fontFamily: "inherit",
                    }}
                  >Dismiss</button>
                </div>
              </div>
            ))}
          </div>
        )}

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
              {/* Vision (PR #218): show attached-image thumbnails ABOVE the
                  text on a user bubble — the operator usually pastes the
                  image first, then types the question. */}
              {m.role === "user" && m.attachmentPreviews && m.attachmentPreviews.length > 0 && (
                <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
                  {m.attachmentPreviews.map((url, i) => (
                    <img
                      key={i}
                      src={url}
                      alt=""
                      style={{
                        width: 64, height: 64, objectFit: "cover",
                        borderRadius: 4, border: "1px solid rgba(255,255,255,0.25)",
                      }}
                    />
                  ))}
                </div>
              )}
              {m.role === "assistant" && !m.pending && !m.error
                ? <RenderedMessage text={m.text} />
                : m.role === "user" && editingUserId === m.id
                  ? (
                    /* Inline edit form for an existing user message.
                       On save, send() runs with a truncated baseMessages —
                       everything after this message is dropped + replaced
                       with the new question + a fresh streamed reply. */
                    <div>
                      <textarea
                        value={editingDraft}
                        onChange={e => setEditingDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            editAndResend(m.id, editingDraft);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setEditingUserId(null);
                            setEditingDraft("");
                          }
                        }}
                        rows={Math.min(8, Math.max(2, editingDraft.split("\n").length + 1))}
                        autoFocus
                        style={{
                          width: "100%", boxSizing: "border-box",
                          background: "rgba(15,23,42,0.5)",
                          border: "1px solid rgba(255,255,255,0.4)",
                          borderRadius: 6, padding: "6px 8px",
                          color: "#fff", fontSize: 13, fontFamily: "inherit", resize: "vertical",
                        }}
                      />
                      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                        <button
                          onClick={() => editAndResend(m.id, editingDraft)}
                          disabled={busy || !editingDraft.trim()}
                          style={{
                            background: "rgba(255,255,255,0.2)", color: "#fff",
                            border: "1px solid rgba(255,255,255,0.4)",
                            borderRadius: 4, padding: "3px 10px",
                            fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                          }}
                        >Save & resend</button>
                        <button
                          onClick={() => { setEditingUserId(null); setEditingDraft(""); }}
                          disabled={busy}
                          style={{
                            background: "transparent", color: "rgba(255,255,255,0.85)",
                            border: "1px solid rgba(255,255,255,0.3)",
                            borderRadius: 4, padding: "3px 10px",
                            fontSize: 11, cursor: "pointer", fontFamily: "inherit",
                          }}
                        >Cancel</button>
                      </div>
                    </div>
                  )
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
              {/* Per-bubble vanilla-Claude-style actions: Copy +
                  Regenerate on assistant bubbles, Edit on user bubbles.
                  Hidden during pending/error states + while busy. */}
              {m.role === "assistant" && !m.pending && !m.error && (
                <div style={{
                  display: "flex", gap: 10, marginTop: 6, alignItems: "center",
                }}>
                  <button
                    type="button"
                    onClick={() => copyMessage(m.id, m.text)}
                    title="Copy this answer"
                    style={bubbleActionStyle}
                    onMouseEnter={e => (e.currentTarget.style.color = "#94A3B8")}
                    onMouseLeave={e => (e.currentTarget.style.color = "#64748B")}
                  >
                    {m.justCopied ? "✓ Copied" : "Copy"}
                  </button>
                  <button
                    type="button"
                    onClick={() => regenerate(m.id)}
                    disabled={busy}
                    title="Re-ask the previous question — useful if the AI answered the wrong thing"
                    style={{ ...bubbleActionStyle, opacity: busy ? 0.4 : 1, cursor: busy ? "not-allowed" : "pointer" }}
                    onMouseEnter={e => { if (!busy) e.currentTarget.style.color = "#94A3B8"; }}
                    onMouseLeave={e => (e.currentTarget.style.color = "#64748B")}
                  >
                    ↻ Regenerate
                  </button>
                </div>
              )}
              {m.role === "user" && editingUserId !== m.id && (
                <div style={{ marginTop: 6 }}>
                  <button
                    type="button"
                    onClick={() => { setEditingUserId(m.id); setEditingDraft(m.text); }}
                    disabled={busy}
                    title="Edit this message — replies after it will be dropped + replaced"
                    style={{
                      background: "none", border: "none", padding: 0,
                      color: "rgba(255,255,255,0.75)", fontStyle: "italic",
                      fontSize: 10, fontFamily: "inherit",
                      cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.5 : 1,
                    }}
                  >
                    ✎ Edit
                  </button>
                </div>
              )}
              {/* "Why?" trace — collapsible list of the server-side
                  tool calls behind this answer. Hidden by default so the
                  bubble stays clean; click to expand. Lets the operator
                  audit which tables were touched + spot when the AI
                  answered the wrong question (e.g. queried wrong
                  customer_id). Tier 2G of the Ask AI improvement plan. */}
              {m.role === "assistant" && m.trace && m.trace.length > 0 && !m.pending && (
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    onClick={() => setMessages(prev => prev.map(x =>
                      x.id === m.id ? { ...x, traceExpanded: !x.traceExpanded } : x,
                    ))}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#64748B",
                      cursor: "pointer",
                      padding: 0,
                      fontSize: 10,
                      fontFamily: "inherit",
                      fontStyle: "italic",
                    }}
                    onMouseEnter={e => (e.currentTarget.style.color = "#94A3B8")}
                    onMouseLeave={e => (e.currentTarget.style.color = "#64748B")}
                  >
                    {m.traceExpanded ? "▾" : "▸"} Why? {m.trace.length} tool call{m.trace.length === 1 ? "" : "s"}
                  </button>
                  {m.traceExpanded && (
                    <div style={{
                      marginTop: 4,
                      paddingLeft: 12,
                      borderLeft: "2px solid #334155",
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                    }}>
                      {m.trace.map((t, i) => (
                        <div
                          key={i}
                          style={{
                            fontSize: 10,
                            color: "#94A3B8",
                            fontFamily: "ui-monospace, SFMono-Regular, monospace",
                            lineHeight: 1.5,
                          }}
                        >
                          <span style={{ color: "#64748B" }}>{i + 1}.</span> {t.summary || t.tool}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {/* Tier 3L: capture-as-fact affordance. Visible under any
                  non-pending, non-error assistant message. Click toggles
                  an inline form; saving POSTs to /api/internal/ai/user-facts
                  AND offers a memory-tree .md download so the same fact
                  lives in both surfaces. */}
              {m.role === "assistant" && !m.pending && !m.error && (
                <div style={{ marginTop: 6 }}>
                  {!m.factCaptured && !m.captureOpen && (
                    <button
                      type="button"
                      onClick={() => setMessages(prev => prev.map(x => x.id === m.id ? {
                        ...x, captureOpen: true, captureTopic: x.captureTopic || "", captureScope: x.captureScope || "self",
                      } : x))}
                      style={{
                        background: "none", border: "none", color: "#64748B",
                        cursor: "pointer", padding: 0, fontSize: 10, fontFamily: "inherit", fontStyle: "italic",
                      }}
                      onMouseEnter={e => (e.currentTarget.style.color = "#94A3B8")}
                      onMouseLeave={e => (e.currentTarget.style.color = "#64748B")}
                    >
                      + Save as fact
                    </button>
                  )}
                  {m.factCaptured && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10, color: "#10B981" }}>
                      <span>✓ Captured as fact</span>
                      <button
                        type="button"
                        onClick={() => downloadMessageAsMemoryFile(m.id)}
                        style={{
                          background: "none", border: "none", color: "#60A5FA",
                          cursor: "pointer", padding: 0, fontSize: 10, fontFamily: "inherit", textDecoration: "underline",
                        }}
                      >
                        Download .md for memory tree
                      </button>
                    </div>
                  )}
                  {m.captureOpen && (
                    <div style={{
                      marginTop: 4, padding: 8, background: "#162033",
                      border: "1px solid #334155", borderRadius: 6,
                      display: "flex", flexDirection: "column", gap: 6,
                    }}>
                      <input
                        placeholder='Topic (e.g. "RYB0412" or "Burlington")'
                        value={m.captureTopic || ""}
                        onChange={e => {
                          const v = e.target.value;
                          setMessages(prev => prev.map(x => x.id === m.id ? { ...x, captureTopic: v } : x));
                        }}
                        maxLength={80}
                        style={{
                          background: "#0F172A", color: "#F1F5F9",
                          border: "1px solid #334155", borderRadius: 4,
                          padding: "4px 8px", fontSize: 11, fontFamily: "inherit",
                        }}
                      />
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <SearchableSelect
                          value={m.captureScope || "self"}
                          onChange={v => {
                            setMessages(prev => prev.map(x => x.id === m.id ? { ...x, captureScope: v as "self" | "global" } : x));
                          }}
                          options={[
                            { value: "self", label: "Just me" },
                            { value: "global", label: "Everyone" },
                          ]}
                          inputStyle={{
                            background: "#0F172A", color: "#F1F5F9",
                            border: "1px solid #334155", borderRadius: 4,
                            padding: "4px 8px", fontSize: 11, fontFamily: "inherit",
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => captureMessageAsFact(m.id)}
                          disabled={m.captureBusy}
                          style={{
                            background: "#3B82F6", color: "#fff", border: "1px solid #3B82F6",
                            borderRadius: 4, padding: "4px 10px", fontSize: 11, cursor: "pointer", fontFamily: "inherit", fontWeight: 600,
                          }}
                        >
                          {m.captureBusy ? "Saving…" : "Save"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setMessages(prev => prev.map(x => x.id === m.id ? {
                            ...x, captureOpen: false, captureError: undefined,
                          } : x))}
                          disabled={m.captureBusy}
                          style={{
                            background: "transparent", color: "#94A3B8", border: "1px solid #334155",
                            borderRadius: 4, padding: "4px 10px", fontSize: 11, cursor: "pointer", fontFamily: "inherit",
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                      {m.captureError && (
                        <div style={{ color: "#FCA5A5", fontSize: 10 }}>{m.captureError}</div>
                      )}
                    </div>
                  )}
                </div>
              )}
              {m.cached && (
                <div style={{ marginTop: 6, fontSize: 10, color: "#94A3B8", fontStyle: "italic", display: "flex", alignItems: "center", gap: 8 }}>
                  <span>Cached answer{typeof m.cachedAgeSeconds === "number" ? ` · ${formatAge(m.cachedAgeSeconds)} ago` : ""}</span>
                </div>
              )}
            </div>
          ))}
        </div>

        <div
          style={{
            padding: 12,
            borderTop: "1px solid #1E293B",
            background: dragActive ? "#1E40AF22" : "#0F172A",
            transition: "background 0.1s",
          }}
          onDragOver={e => {
            if (e.dataTransfer?.types?.includes("Files")) {
              e.preventDefault();
              setDragActive(true);
            }
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={e => {
            e.preventDefault();
            setDragActive(false);
            const files = imagesFromDataTransferItems(e.dataTransfer?.items);
            if (files.length > 0) addAttachments(files);
          }}
        >
          {/* Vision (PR #218): staged-attachment thumbnail strip + error. */}
          {attachments.length > 0 && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
              {attachments.map((a, i) => (
                <div key={`${a.name}-${i}`} style={{
                  position: "relative", width: 56, height: 56,
                  background: "#1E293B", border: "1px solid #334155",
                  borderRadius: 6, overflow: "hidden",
                }}>
                  <img src={a.previewUrl} alt={a.name} title={`${a.name} · ${(a.size / 1024).toFixed(0)} KB`}
                    style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  <button type="button" onClick={() => removeAttachment(i)} title="Remove attachment"
                    style={{
                      position: "absolute", top: 2, right: 2, width: 16, height: 16, lineHeight: "14px",
                      background: "rgba(0,0,0,0.7)", color: "#fff", border: "none", borderRadius: 999,
                      cursor: "pointer", fontSize: 11, padding: 0,
                    }}>×</button>
                </div>
              ))}
            </div>
          )}
          {attachmentError && (
            <div style={{ color: "#FCA5A5", fontSize: 11, marginBottom: 6 }}>{attachmentError}</div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1, position: "relative" }}>
              {/* @mention autocomplete: parses @ / # tokens around the
                  caret, fetches matches from /api/internal/ai/mention-suggest,
                  and rewrites the input with an embedded id marker
                  (e.g. "@Burlington«cust:abc123»") that the panel strips
                  before sending. The system prompt is told to skip
                  find_customer/find_style for pre-resolved entities. */}
              <MentionAutocomplete
                value={input}
                caret={caret}
                onCommit={({ value, caret: newCaret, item }) => {
                  setInput(value);
                  setCaret(newCaret);
                  // Register the resolution so send() can expand the
                  // token to an id parenthetical before hitting Claude.
                  mentionMapRef.current.set(item.label.replace(/\s+/g, "_"), {
                    id: item.id, type: item.type, label: item.label,
                  });
                  setTimeout(() => {
                    const ta = inputRef.current;
                    if (ta) { ta.focus(); ta.setSelectionRange(newCaret, newCaret); }
                  }, 0);
                }}
                onCancel={() => { mentionKeyHandlerRef.current = null; }}
                registerKeyHandler={(h) => { mentionKeyHandlerRef.current = h; }}
              />
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => { setInput(e.target.value); setCaret(e.target.selectionStart); }}
                onKeyDown={e => {
                  // Defer to the mention dropdown's handler when open.
                  // It only intercepts ↑/↓/Enter/Tab/Esc — anything
                  // else falls through to our regular onKeyDown.
                  const h = mentionKeyHandlerRef.current;
                  if (h && h(e)) return;
                  onKeyDown(e);
                }}
                onKeyUp={e => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
                onClick={e => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
                onPaste={e => {
                  // Vision (PR #218): a pasted screenshot becomes an attachment.
                  const files = imagesFromDataTransferItems(e.clipboardData?.items);
                  if (files.length > 0) { e.preventDefault(); addAttachments(files); }
                }}
                placeholder={attachments.length > 0
                  ? "Ask about this image, or hit Enter…"
                  : "Ask anything ROF related… (@ customer, # style, paste a screenshot)"}
                rows={2}
                disabled={busy}
                style={{
                  width: "100%", boxSizing: "border-box",
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
            </div>
            <button
              onClick={() => send(input)}
              disabled={busy || (!input.trim() && attachments.length === 0)}
              style={{
                background: busy || (!input.trim() && attachments.length === 0) ? "#1E293B" : "#3B82F6",
                color: busy || (!input.trim() && attachments.length === 0) ? "#64748B" : "#fff",
                border: "none",
                borderRadius: 8,
                padding: "0 14px",
                fontSize: 13,
                fontWeight: 600,
                cursor: busy || (!input.trim() && attachments.length === 0) ? "not-allowed" : "pointer",
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
