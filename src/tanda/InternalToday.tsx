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

  const openItem = (it: { panel?: string | null; href?: string }) => {
    if (it.panel) goToPanel(it.panel);
    else if (it.href) window.location.href = it.href;
  };

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
            {data ? fmtDateUS(data.greeting.date) : ""} — here is where your day stands.
          </div>
        </div>
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
