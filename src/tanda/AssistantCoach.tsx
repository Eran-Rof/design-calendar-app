// src/tanda/AssistantCoach.tsx
//
// P28-3 — panel-scoped coach tips. When the operator lands on a module
// that has a matching suggestion in their Today aggregate ("you're on
// Style Master and 2,119 styles can be bulk scale-assigned"), a small
// dismissible chip appears above the Ask AI button.
//
// Anti-nag rules (arch §7 — "a nagging assistant is worse than none"):
//   - one tip per module per TAB SESSION (sessionStorage), even undismissed
//   - ✕ persists a server-side dismissal for the rest of the day (same
//     assistant_dismissals row the Today page uses)
//   - suggestions arrive already RBAC- and dismissal-filtered server-side
//   - aggregate is fetched once and cached 5 minutes per tab

import React, { useEffect, useState } from "react";
import { askAI } from "../ai/askAIBridge";

type Suggestion = { key: string; text: string; panel?: string | null };

const SESSION_SEEN_KEY = "tangerine:coach:seen:v1";      // JSON string[]
const CACHE_KEY = "tangerine:coach:aggregate:v1";        // {at, suggestions}
const CACHE_TTL_MS = 5 * 60 * 1000;

function readSeen(): Set<string> {
  try { return new Set(JSON.parse(sessionStorage.getItem(SESSION_SEEN_KEY) || "[]")); }
  catch { return new Set(); }
}
function markSeen(key: string): void {
  try {
    const seen = readSeen();
    seen.add(key);
    sessionStorage.setItem(SESSION_SEEN_KEY, JSON.stringify([...seen]));
  } catch { /* session hint only */ }
}

/** Pure tip selection — exported for tests. */
export function pickCoachTip(
  suggestions: Suggestion[],
  activeModule: string | null,
  seen: Set<string>,
): Suggestion | null {
  if (!activeModule) return null;
  return suggestions.find((s) => s.panel === activeModule && !seen.has(s.key)) || null;
}

async function fetchSuggestions(): Promise<Suggestion[]> {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      if (c && Date.now() - c.at < CACHE_TTL_MS && Array.isArray(c.suggestions)) return c.suggestions;
    }
  } catch { /* fall through to fetch */ }
  const r = await fetch("/api/internal/assistant/today");
  const j = await r.json();
  const suggestions: Suggestion[] = Array.isArray(j?.suggestions) ? j.suggestions : [];
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), suggestions })); } catch { /* best effort */ }
  return suggestions;
}

export default function AssistantCoach({ activeModule }: { activeModule: string | null }) {
  const [tip, setTip] = useState<Suggestion | null>(null);

  useEffect(() => {
    let alive = true;
    setTip(null);
    if (!activeModule || activeModule === "today") return; // Today shows suggestions itself
    fetchSuggestions()
      .then((sugg) => { if (alive) setTip(pickCoachTip(sugg, activeModule, readSeen())); })
      .catch(() => { /* coach is decoration — never surface errors */ });
    return () => { alive = false; };
  }, [activeModule]);

  if (!tip) return null;

  const close = () => { markSeen(tip.key); setTip(null); };

  return (
    <div
      style={{
        position: "fixed", right: 24, bottom: 84, zIndex: 60, maxWidth: 340,
        background: "#1E293B", border: "1px solid #334155", borderRadius: 10,
        padding: "10px 12px", color: "#CBD5E1", fontSize: 13, lineHeight: 1.45,
        boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <span style={{ color: "#fbbf24", fontWeight: 700 }}>•</span>
        <div style={{ flex: 1 }}>{tip.text}</div>
        <button
          title="Dismiss for today"
          onClick={() => {
            fetch("/api/internal/assistant/dismiss", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ item_key: tip.key }),
            }).catch(() => { /* session-seen already hides it */ });
            close();
          }}
          style={{ background: "transparent", border: "none", color: "#94A3B8", cursor: "pointer", fontSize: 14, padding: 0 }}
        >
          ✕
        </button>
      </div>
      <button
        onClick={() => { askAI({ prompt: `Tell me more: ${tip.text}`, source: "coach-tip" }); close(); }}
        style={{
          marginTop: 8, background: "transparent", border: "1px solid #334155", color: "#94A3B8",
          borderRadius: 7, padding: "4px 10px", cursor: "pointer", fontSize: 12,
        }}
      >
        Ask the assistant
      </button>
    </div>
  );
}
