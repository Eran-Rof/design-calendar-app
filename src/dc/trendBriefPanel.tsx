// src/dc/trendBriefPanel.tsx
//
// AI design pipeline — Stage 2 UI. Lists monthly Claude-synthesized trend
// briefs, shows a drawer with summary + themes when one is clicked, and
// surfaces draft → published → archived status toggles.
//
// Generation is offline (`scripts/post_trend_brief.py`); this panel is
// read + light-mutate only. The v2 plan's verification step 3 says
// designer self-evaluation gates whether stages 4+ are built — this is
// where that reading + judgement happens.

import React, { useEffect, useMemo, useState } from "react";
import { TH } from "../utils/theme";
import { SB_URL, SB_HEADERS } from "../utils/supabase";

type TrendBrief = {
  id: string;
  brief_month: string;
  status: "draft" | "published" | "archived";
  title: string | null;
  summary_md: string | null;
  themes_jsonb: Theme[] | null;
  model: string | null;
  token_usage: { input_tokens?: number; output_tokens?: number; cost_usd?: number } | null;
  created_at: string;
  updated_at: string;
};

type Theme = {
  name: string;
  description?: string;
  signals?: string[];
  sources?: string[];
  confidence?: number;
  direction?: "rising" | "peaking" | "fading";
};

function fmtMonth(d: string): string {
  if (!d) return "—";
  const dt = new Date(d + (d.length === 10 ? "T00:00:00Z" : ""));
  if (isNaN(dt.getTime())) return d;
  return dt.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

const STATUS_STYLES: Record<TrendBrief["status"], { bg: string; bdr: string; fg: string }> = {
  draft:     { bg: "#FFF5E6", bdr: "#F6AD55", fg: "#7B341E" },
  published: { bg: "#E6FFFA", bdr: "#38B2AC", fg: "#234E52" },
  archived:  { bg: "#EDF2F7", bdr: "#A0AEC0", fg: "#4A5568" },
};

const DIRECTION_DOT: Record<NonNullable<Theme["direction"]>, string> = {
  rising:  "#48BB78",
  peaking: "#ED8936",
  fading:  "#A0AEC0",
};

// Minimal markdown → HTML for the summary. Claude's output uses just
// headings, paragraphs, bold, italics, bullets — keep it small, no new dep.
function renderMd(md: string): string {
  if (!md) return "";
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inList = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push("");
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      if (inList) { out.push("</ul>"); inList = false; }
      const level = Math.min(h[1].length + 1, 6);
      out.push(`<h${level}>${esc(h[2])}</h${level}>`);
      continue;
    }
    const li = line.match(/^[-*]\s+(.*)$/);
    if (li) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (inList) { out.push("</ul>"); inList = false; }
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push("</ul>");
  return out.join("\n");

  function inline(s: string): string {
    return esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }
}

export function TrendBriefPanel(): React.ReactElement {
  const [briefs, setBriefs]   = useState<TrendBrief[]>([]);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg]   = useState<string | null>(null);
  const [selected, setSelected] = useState<TrendBrief | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  async function load() {
    setLoading(true);
    setErrMsg(null);
    try {
      const statusFilter = showArchived ? "" : "&status=neq.archived";
      const res = await fetch(
        `${SB_URL}/rest/v1/ip_trend_briefs?select=*&order=brief_month.desc&limit=48${statusFilter}`,
        { headers: SB_HEADERS },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || JSON.stringify(data));
      setBriefs(data as TrendBrief[]);
    } catch (e: any) {
      setErrMsg(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [showArchived]);

  async function setStatus(brief: TrendBrief, status: TrendBrief["status"]) {
    try {
      const res = await fetch(
        `${SB_URL}/rest/v1/ip_trend_briefs?id=eq.${brief.id}`,
        {
          method: "PATCH",
          headers: { ...SB_HEADERS, Prefer: "return=representation" },
          body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || JSON.stringify(data));
      setBriefs(bs => bs.map(b => (b.id === brief.id ? { ...b, status } : b)));
      if (selected?.id === brief.id) setSelected({ ...selected, status });
    } catch (e: any) {
      alert("Update failed: " + (e?.message || String(e)));
    }
  }

  const sorted = useMemo(
    () => [...briefs].sort((a, b) => b.brief_month.localeCompare(a.brief_month)),
    [briefs],
  );

  return (
    <div style={{ color: TH.text }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 22, color: TH.surface }}>Trend Briefs</h2>
        <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 13 }}>
          Monthly AI-synthesized direction for the design team
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ color: "rgba(255,255,255,0.7)", fontSize: 12, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={showArchived}
              onChange={e => setShowArchived(e.target.checked)}
              style={{ marginRight: 6 }}
            />
            Show archived
          </label>
          <button
            onClick={load}
            style={{
              padding: "6px 12px",
              borderRadius: 6,
              border: "1px solid rgba(255,255,255,0.2)",
              background: "rgba(255,255,255,0.06)",
              color: "rgba(255,255,255,0.9)",
              fontFamily: "inherit",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      {errMsg && (
        <div style={{ marginBottom: 14, padding: 10, background: "#FEF2F2", border: "1px solid #FCA5A5", borderRadius: 6, color: "#B91C1C", fontSize: 13 }}>
          Failed to load briefs: {errMsg}
        </div>
      )}

      {loading && <div style={{ color: "rgba(255,255,255,0.5)", padding: 20 }}>Loading…</div>}

      {!loading && sorted.length === 0 && (
        <div style={{
          background: TH.surface, color: TH.textMuted, padding: 24, borderRadius: 10,
          border: `1px dashed ${TH.border}`, fontSize: 14, textAlign: "center",
        }}>
          No briefs yet. Generate one via:<br />
          <code style={{ display: "inline-block", marginTop: 8, background: "#F7F8FA", padding: "4px 8px", borderRadius: 4 }}>
            python scripts/fetch_trend_sources.py --month YYYY-MM
          </code>{" "}
          <code style={{ display: "inline-block", marginTop: 8, background: "#F7F8FA", padding: "4px 8px", borderRadius: 4 }}>
            python scripts/post_trend_brief.py --month YYYY-MM
          </code>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 12 }}>
        {sorted.map(b => {
          const s = STATUS_STYLES[b.status];
          const themeCount = (b.themes_jsonb || []).length;
          const cost = b.token_usage?.cost_usd;
          return (
            <div
              key={b.id}
              onClick={() => setSelected(b)}
              style={{
                background: TH.surface,
                border: `1px solid ${TH.border}`,
                borderRadius: 10,
                padding: 14,
                cursor: "pointer",
                boxShadow: `0 1px 2px ${TH.shadow}`,
                transition: "transform 0.1s, box-shadow 0.1s",
              }}
              onMouseEnter={e => (e.currentTarget.style.transform = "translateY(-1px)")}
              onMouseLeave={e => (e.currentTarget.style.transform = "translateY(0)")}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: TH.text }}>{fmtMonth(b.brief_month)}</div>
                <span style={{
                  fontSize: 10, fontWeight: 700, textTransform: "uppercase",
                  padding: "2px 8px", borderRadius: 4,
                  background: s.bg, color: s.fg, border: `1px solid ${s.bdr}`,
                }}>
                  {b.status}
                </span>
              </div>
              <div style={{ fontSize: 13, color: TH.textSub, marginBottom: 8, lineHeight: 1.35 }}>
                {b.title || "(no title)"}
              </div>
              <div style={{ fontSize: 11, color: TH.textMuted }}>
                {themeCount} theme{themeCount === 1 ? "" : "s"}
                {cost != null && ` · $${cost.toFixed(4)}`}
                {b.model && ` · ${b.model}`}
              </div>
            </div>
          );
        })}
      </div>

      {selected && (
        <BriefDrawer
          brief={selected}
          onClose={() => setSelected(null)}
          onStatusChange={status => setStatus(selected, status)}
        />
      )}
    </div>
  );
}

function BriefDrawer({
  brief, onClose, onStatusChange,
}: {
  brief: TrendBrief;
  onClose: () => void;
  onStatusChange: (s: TrendBrief["status"]) => void;
}) {
  const themes = brief.themes_jsonb || [];
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
        zIndex: 100, display: "flex", justifyContent: "flex-end",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: "min(720px, 100%)", height: "100%", background: TH.surface,
          overflowY: "auto", boxShadow: "-4px 0 12px rgba(0,0,0,0.2)",
          color: TH.text,
        }}
      >
        <div style={{ padding: "16px 22px", borderBottom: `1px solid ${TH.border}`, position: "sticky", top: 0, background: TH.surface, zIndex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <div style={{ fontSize: 12, color: TH.textMuted }}>{fmtMonth(brief.brief_month)}</div>
            <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: TH.textMuted }}>×</button>
          </div>
          <h2 style={{ margin: 0, fontSize: 20, color: TH.text }}>{brief.title || "(no title)"}</h2>
          <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(["draft", "published", "archived"] as const).map(s => (
              <button
                key={s}
                onClick={() => onStatusChange(s)}
                disabled={brief.status === s}
                style={{
                  padding: "4px 10px", borderRadius: 4, fontSize: 11, fontWeight: 600,
                  textTransform: "uppercase",
                  background: brief.status === s ? STATUS_STYLES[s].bg : "transparent",
                  color: brief.status === s ? STATUS_STYLES[s].fg : TH.textMuted,
                  border: `1px solid ${brief.status === s ? STATUS_STYLES[s].bdr : TH.border}`,
                  cursor: brief.status === s ? "default" : "pointer",
                  fontFamily: "inherit",
                }}
              >
                {brief.status === s ? `✓ ${s}` : s}
              </button>
            ))}
          </div>
        </div>

        <div style={{ padding: 22 }}>
          {brief.summary_md && (
            <div
              className="trend-brief-md"
              style={{ fontSize: 14, lineHeight: 1.55, marginBottom: 22 }}
              dangerouslySetInnerHTML={{ __html: renderMd(brief.summary_md) }}
            />
          )}

          {themes.length > 0 && (
            <div>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: TH.textSub, marginBottom: 10, paddingBottom: 6, borderBottom: `1px solid ${TH.border}` }}>
                Themes ({themes.length})
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {themes.map((t, i) => (
                  <div key={i} style={{ background: TH.surfaceHi, border: `1px solid ${TH.border}`, borderRadius: 6, padding: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      {t.direction && (
                        <span
                          title={t.direction}
                          style={{ width: 8, height: 8, borderRadius: "50%", background: DIRECTION_DOT[t.direction], display: "inline-block" }}
                        />
                      )}
                      <span style={{ fontWeight: 700, fontSize: 13, color: TH.text }}>{t.name}</span>
                      {typeof t.confidence === "number" && (
                        <span style={{ fontSize: 10, color: TH.textMuted, marginLeft: "auto" }}>
                          confidence {Math.round(t.confidence * 100)}%
                        </span>
                      )}
                    </div>
                    {t.description && (
                      <div style={{ fontSize: 12, color: TH.textSub2, marginBottom: 8, lineHeight: 1.4 }}>{t.description}</div>
                    )}
                    {Array.isArray(t.signals) && t.signals.length > 0 && (
                      <ul style={{ margin: "0 0 6px 18px", padding: 0, fontSize: 12, color: TH.textSub2, lineHeight: 1.45 }}>
                        {t.signals.map((sig, j) => <li key={j}>{sig}</li>)}
                      </ul>
                    )}
                    {Array.isArray(t.sources) && t.sources.length > 0 && (
                      <div style={{ fontSize: 10, color: TH.textMuted, marginTop: 4 }}>
                        sources: {t.sources.join(", ")}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ marginTop: 22, fontSize: 11, color: TH.textMuted, borderTop: `1px solid ${TH.border}`, paddingTop: 10 }}>
            {brief.model} · generated {new Date(brief.created_at).toLocaleString()}
            {brief.token_usage?.cost_usd != null && ` · cost $${brief.token_usage.cost_usd.toFixed(4)}`}
            {brief.token_usage?.input_tokens != null && ` · ${brief.token_usage.input_tokens.toLocaleString()} in / ${brief.token_usage.output_tokens?.toLocaleString() || 0} out`}
          </div>
        </div>
      </div>
    </div>
  );
}
