// src/tanda/InternalToday.tsx
//
// P28-1-2 — the assistant-first "Today" landing page (arch §5).
// Deterministic core: everything rendered here is computed server-side from
// live queues by /api/internal/assistant/today (capability packs) — no AI in
// the rendering path. Phase 2 adds the assistant's phrased brief + chat.
//
// Sections: greeting bar · Your to-dos · Active processes · Current state.
// Every to-do row is full-row clickable into its owning panel (blue title,
// no ↗ per the drill conventions); ✕ dismisses it for the rest of the day.

import React, { useCallback, useEffect, useState } from "react";
import { getCachedAuthUserName } from "../utils/tangerineAuthUser";
import { usePersonalization } from "../hooks/usePersonalization";
import { notify } from "../shared/ui/warn";
import { MODULES } from "../erp/modules";
import { resolveIntent, type IntentAlternative } from "./todayIntentRouter";

// menuKeys key for this page — setting it as home_route makes Today the
// operator's auto-landing screen (T4-4 redirect, once per tab session).
const TODAY_MENU_KEY = "tanda/today";

const C = {
  bg: "#0F172A",
  card: "#1E293B",
  cardBdr: "#334155",
  text: "#F1F5F9",
  textMuted: "#94A3B8",
  textSub: "#CBD5E1",
  primary: "#3B82F6",
};

type TodoItem = {
  key: string; title: string; detail?: string; count: number;
  severity: "action" | "warn" | "error" | "info";
  panel?: string | null; href?: string; pack: string;
};
type ProcessItem = {
  key: string; label: string; state: "ok" | "running" | "warn" | "error";
  detail?: string; last_run_at?: string | null; panel?: string | null; pack: string;
};
type SuggestionItem = { key: string; text: string; panel?: string | null; pack: string };
type InsightRow = { id: string | number; title?: string; summary?: string; recommendation?: string };

type TodayPayload = {
  greeting: { name: string | null; date: string };
  can_dismiss: boolean;
  todos: TodoItem[];
  processes: ProcessItem[];
  suggestions: SuggestionItem[];
  insights: InsightRow[];
  errors: { pack: string; provider: string; error: string }[];
};

const SEVERITY_STYLE: Record<string, { label: string; color: string; bg: string }> = {
  action: { label: "Action", color: "#fbbf24", bg: "rgba(251,191,36,0.12)" },
  error:  { label: "Error",  color: "#f87171", bg: "rgba(248,113,113,0.12)" },
  warn:   { label: "Watch",  color: "#fb923c", bg: "rgba(251,146,60,0.12)" },
  info:   { label: "FYI",    color: "#60a5fa", bg: "rgba(96,165,250,0.12)" },
};

const STATE_DOT: Record<string, string> = {
  ok: "#34d399", running: "#60a5fa", warn: "#fbbf24", error: "#f87171",
};

/** Same-shell module hop — the URL contract every panel honors (?m= +
 *  synthetic popstate; see scorecardDrill.ts).                          */
function goToPanel(moduleKey: string): void {
  const url = new URL(window.location.href);
  for (const k of ["vendor", "customer", "q"]) url.searchParams.delete(k);
  url.searchParams.set("m", moduleKey);
  window.history.pushState({ module: moduleKey }, "", url.toString());
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function fmtDateUS(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

function greetingWord(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

export default function InternalToday() {
  const [data, setData] = useState<TodayPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const { homeRoute, setHomeRoute, status: prefStatus } = usePersonalization();
  const isHome = homeRoute === TODAY_MENU_KEY;

  // P28-2 — the assistant's morning brief (one model run per user per day,
  // cached server-side). Fail-soft: body null → templated greeting only.
  const [brief, setBrief] = useState<string | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [ask, setAsk] = useState("");
  // Router alternatives shown as chips when an intent is ambiguous, or a
  // gentle hint when nothing matched. Cleared on any successful navigation.
  const [askAlts, setAskAlts] = useState<IntentAlternative[] | null>(null);
  const [askHint, setAskHint] = useState("");

  const loadBrief = useCallback((refresh = false) => {
    setBriefLoading(true);
    fetch(`/api/internal/assistant/brief${refresh ? "?refresh=1" : ""}`)
      .then((r) => r.json())
      .then((j) => setBrief(typeof j?.body === "string" && j.body ? j.body : null))
      .catch(() => setBrief(null))
      .finally(() => setBriefLoading(false));
  }, []);
  useEffect(() => { loadBrief(); }, [loadBrief]);

  // Navigate to a to-do (its owning panel / href) exactly like a row click.
  const openTodo = useCallback((it: { panel?: string | null; href?: string }) => {
    if (it.panel) goToPanel(it.panel);
    else if (it.href) window.location.href = it.href;
  }, []);

  // Follow a resolved alternative chip (or the confident match itself).
  const followAlt = useCallback((alt: IntentAlternative) => {
    setAskAlts(null);
    setAskHint("");
    setAsk("");
    if (alt.kind === "todo" && alt.todo) { notify(`Opening ${alt.todo.title}`, "info"); openTodo(alt.todo); }
    else if (alt.kind === "module" && alt.module) { notify(`Opening ${alt.module.label}`, "info"); goToPanel(alt.module.key); }
    else if (alt.kind === "suggestion" && alt.suggestion?.panel) { notify("Opening", "info"); goToPanel(alt.suggestion.panel); }
  }, [openTodo]);

  // The field is a pure intent ROUTER — it navigates the operator to the
  // matched panel / live to-do (no chat). The floating Ask AI button remains
  // the surface for actual Q&A.
  const submitAsk = useCallback(() => {
    const q = ask.trim();
    if (!q) return;
    const res = resolveIntent(q, {
      todos: data?.todos || [],
      suggestions: data?.suggestions || [],
      modules: MODULES,
    });
    if (res.kind === "todo" && res.todo) {
      setAskAlts(null); setAskHint(""); setAsk("");
      notify(`Opening ${res.todo.title}`, "info");
      openTodo(res.todo);
    } else if (res.kind === "module" && res.module) {
      setAskAlts(null); setAskHint(""); setAsk("");
      notify(`Opening ${res.module.label}`, "info");
      goToPanel(res.module.key);
    } else if (res.kind === "suggestion" && res.suggestion?.panel) {
      setAskAlts(null); setAskHint(""); setAsk("");
      notify("Opening", "info");
      goToPanel(res.suggestion.panel);
    } else if (res.alternatives.length > 0) {
      setAskAlts(res.alternatives);
      setAskHint("");
    } else {
      setAskAlts(null);
      setAskHint("Try naming one of your to-dos, e.g. “month close” or “chargebacks”.");
    }
  }, [ask, data, openTodo]);

  const load = useCallback(() => {
    setLoading(true);
    setErr("");
    fetch("/api/internal/assistant/today")
      .then((r) => r.json())
      .then((j) => {
        if (j && !j.error) setData(j as TodayPayload);
        else setErr(String(j?.error || "Failed to load"));
      })
      .catch((e) => setErr(String(e?.message || e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const dismiss = useCallback((itemKey: string) => {
    setData((d) => d && {
      ...d,
      todos: d.todos.filter((t) => t.key !== itemKey),
      suggestions: d.suggestions.filter((s) => s.key !== itemKey),
    });
    fetch("/api/internal/assistant/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_key: itemKey }),
    }).catch(() => { /* optimistic; queue re-surfaces tomorrow anyway */ });
  }, []);

  const openItem = openTodo;

  const name = data?.greeting?.name || getCachedAuthUserName() || "";
  const firstName = name.split(/[\s@.]/)[0] || "";

  const section: React.CSSProperties = {
    background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10,
    padding: "14px 16px", marginBottom: 14,
  };
  const h2: React.CSSProperties = {
    margin: "0 0 10px", fontSize: 13, fontWeight: 700, letterSpacing: 0.4,
    textTransform: "uppercase", color: C.textMuted,
  };

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: "18px 16px", color: C.text }}>
      {/* Greeting bar */}
      <div style={{ ...section, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>
            {greetingWord()}{firstName ? `, ${firstName}` : ""}
          </div>
          <div style={{ fontSize: 13, color: C.textSub, marginTop: 2 }}>
            {data ? fmtDateUS(data.greeting.date) : ""}{brief ? "" : " — here is where your day stands."}
          </div>
          {briefLoading && !brief && (
            <div style={{ fontSize: 13.5, color: C.textMuted, marginTop: 8 }}>Your assistant is reading the queues…</div>
          )}
          {brief && (
            <div style={{ fontSize: 14, color: C.textSub, marginTop: 8, maxWidth: 720, lineHeight: 1.5 }}>
              {brief}
              <button
                title="Re-read the queues and rephrase"
                onClick={() => loadBrief(true)}
                style={{ background: "transparent", border: "none", color: C.textMuted, cursor: "pointer", fontSize: 12, marginLeft: 8 }}
              >
                ↻
              </button>
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 10, maxWidth: 560 }}>
            <input
              value={ask}
              onChange={(e) => setAsk(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitAsk(); }}
              onFocus={(e) => e.currentTarget.select()}
              placeholder="What do you want to work on?"
              title="Type where you want to go — e.g. “month close”, “pos flagged here”, “chargebacks”"
              style={{
                flex: 1, background: "#0b1220", border: `1px solid ${C.cardBdr}`, color: C.text,
                borderRadius: 8, padding: "8px 12px", fontSize: 13.5, outline: "none",
              }}
            />
            <button
              onClick={submitAsk}
              disabled={!ask.trim()}
              style={{
                background: ask.trim() ? C.primary : "transparent",
                border: `1px solid ${ask.trim() ? C.primary : C.cardBdr}`,
                color: ask.trim() ? "#fff" : C.textMuted,
                borderRadius: 8, padding: "8px 14px", cursor: ask.trim() ? "pointer" : "default", fontSize: 13.5,
              }}
            >
              Go
            </button>
          </div>
          {askAlts && askAlts.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8, maxWidth: 560, alignItems: "center" }}>
              <span style={{ fontSize: 12.5, color: C.textMuted }}>Did you mean:</span>
              {askAlts.map((alt, i) => (
                <button
                  key={`${alt.kind}-${alt.todo?.key || alt.module?.key || alt.suggestion?.key || i}`}
                  onClick={() => followAlt(alt)}
                  style={{
                    background: "transparent", border: `1px solid ${C.primary}`, color: C.primary,
                    borderRadius: 999, padding: "4px 12px", cursor: "pointer", fontSize: 12.5, fontWeight: 600,
                  }}
                >
                  {alt.label}
                </button>
              ))}
            </div>
          )}
          {askHint && (
            <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 8, maxWidth: 560 }}>{askHint}</div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {prefStatus === "ready" && !isHome && (
            <button
              title="Land on Today when you open Tangerine"
              onClick={() => { setHomeRoute(TODAY_MENU_KEY).catch(() => {}); }}
              style={{
                background: "transparent", border: `1px solid ${C.cardBdr}`, color: C.textSub,
                borderRadius: 8, padding: "6px 12px", cursor: "pointer", fontSize: 13,
              }}
            >
              ★ Make this my landing page
            </button>
          )}
          {prefStatus === "ready" && isHome && (
            <span style={{ color: C.textMuted, fontSize: 13, alignSelf: "center" }}>★ Your landing page</span>
          )}
          <button
            onClick={load}
            style={{
              background: "transparent", border: `1px solid ${C.cardBdr}`, color: C.textSub,
              borderRadius: 8, padding: "6px 12px", cursor: "pointer", fontSize: 13,
            }}
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {err && (
        <div style={{ ...section, borderColor: "#7f1d1d", color: "#fca5a5" }}>{err}</div>
      )}
      {loading && !data && (
        <div style={{ ...section, color: C.textMuted }}>Loading your day…</div>
      )}

      {data && (
        <>
          {/* Your to-dos */}
          <div style={section}>
            <h2 style={h2}>Your to-dos</h2>
            {data.todos.length === 0 && (
              <div style={{ color: C.textMuted, fontSize: 14 }}>Nothing waiting on you — clear queue.</div>
            )}
            {data.todos.map((t) => {
              const sev = SEVERITY_STYLE[t.severity] || SEVERITY_STYLE.info;
              return (
                <div
                  key={t.key}
                  onClick={() => openItem(t)}
                  style={{
                    display: "flex", alignItems: "center", gap: 12, padding: "9px 8px",
                    borderTop: `1px solid ${C.cardBdr}`, cursor: (t.panel || t.href) ? "pointer" : "default",
                  }}
                >
                  <span style={{
                    fontSize: 11, fontWeight: 700, color: sev.color, background: sev.bg,
                    borderRadius: 6, padding: "2px 8px", minWidth: 52, textAlign: "center",
                  }}>
                    {sev.label}
                  </span>
                  <span style={{ color: C.primary, fontWeight: 600, fontSize: 14 }}>{t.title}</span>
                  <span style={{ color: C.textMuted, fontSize: 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.detail || ""}
                  </span>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>{t.count.toLocaleString()}</span>
                  {data.can_dismiss && (
                    <button
                      title="Done for today"
                      onClick={(e) => { e.stopPropagation(); dismiss(t.key); }}
                      style={{ background: "transparent", border: "none", color: C.textMuted, cursor: "pointer", fontSize: 14, padding: "2px 6px" }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* Active processes */}
          <div style={section}>
            <h2 style={h2}>Active processes</h2>
            {data.processes.length === 0 && (
              <div style={{ color: C.textMuted, fontSize: 14 }}>No process status to report.</div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 10 }}>
              {data.processes.map((p) => (
                <div
                  key={p.key}
                  onClick={() => p.panel && goToPanel(p.panel)}
                  style={{
                    border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: "10px 12px",
                    cursor: p.panel ? "pointer" : "default", background: C.bg,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 9, height: 9, borderRadius: "50%", background: STATE_DOT[p.state] || C.textMuted, flexShrink: 0 }} />
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{p.label}</span>
                  </div>
                  <div style={{ color: C.textMuted, fontSize: 12, marginTop: 5, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {p.detail || p.state}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Current state — suggestions + insights */}
          <div style={section}>
            <h2 style={h2}>Current state</h2>
            {data.suggestions.length === 0 && data.insights.length === 0 && (
              <div style={{ color: C.textMuted, fontSize: 14 }}>No analysis items right now.</div>
            )}
            {data.suggestions.map((s) => (
              <div
                key={s.key}
                onClick={() => s.panel && goToPanel(s.panel)}
                style={{
                  display: "flex", gap: 10, padding: "8px 8px", borderTop: `1px solid ${C.cardBdr}`,
                  cursor: s.panel ? "pointer" : "default", alignItems: "flex-start",
                }}
              >
                <span style={{ color: "#fbbf24", fontWeight: 700 }}>•</span>
                <span style={{ fontSize: 13.5, color: C.textSub, flex: 1 }}>{s.text}</span>
                {data.can_dismiss && (
                  <button
                    title="Done for today"
                    onClick={(e) => { e.stopPropagation(); dismiss(s.key); }}
                    style={{ background: "transparent", border: "none", color: C.textMuted, cursor: "pointer", fontSize: 14 }}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            {data.insights.map((i) => (
              <div key={String(i.id)} style={{ padding: "8px 8px", borderTop: `1px solid ${C.cardBdr}` }}>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{i.title || ""}</div>
                {(i.summary || i.recommendation) && (
                  <div style={{ color: C.textMuted, fontSize: 12.5, marginTop: 3 }}>
                    {i.summary || i.recommendation}
                  </div>
                )}
              </div>
            ))}
          </div>

          {data.errors.length > 0 && (
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 20 }}>
              {data.errors.length} section provider{data.errors.length === 1 ? "" : "s"} failed to load — counts above may be partial.
            </div>
          )}
        </>
      )}
    </div>
  );
}
