// src/tanda/components/RowHistory.tsx
//
// Cross-cutter T11-3 — drop-in audit-trail timeline for detail modals.
//
// Renders the per-row change history pulled from
//   GET /api/internal/audit/row-history?source_table=…&source_id=…
//
// Designed to be dropped into the bottom of any T11 detail modal
// (AR/AP invoice, JE, customer, vendor, employee, case, GL account,
// virtual card). One prop pair drives everything; the component owns
// its own fetch + loading + error + empty states.
//
// Usage:
//   <RowHistory source_table="ar_invoices" source_id={invoice.id} />
//
// Visual contract:
//   - Heading "Audit trail — N changes" (or "No audit history" empty state)
//   - Vertical timeline: each row shows actor display_name + operation badge
//     + reason (when present) + relative time. Click expands the diff:
//     changed_columns chips + before/after JSON side-by-side preview.
//   - Pure inline styles — matches the rest of the Tanda dark palette.

import { useEffect, useMemo, useState } from "react";

type RowChange = {
  id: string;
  operation: "INSERT" | "UPDATE" | "DELETE" | "VOID" | "POST" | "REVERSE";
  changed_at: string;
  actor_auth_id: string | null;
  actor_employee_id: string | null;
  actor_display_name: string | null;
  source: string | null;
  reason: string | null;
  correlation_id: string | null;
  changed_columns: string[];
  before_jsonb: Record<string, unknown> | null;
  after_jsonb: Record<string, unknown> | null;
};

type Resp = {
  source_table: string;
  source_id: string;
  count: number;
  changes: RowChange[];
};

type Props = {
  source_table: string;
  source_id: string;
  /** Optional override; defaults to /api/internal/audit/row-history. */
  endpoint?: string;
};

// Palette (matches the rest of the Internal* panels — keeps drop-in
// blend-in even when placed inside a modal that wasn't pre-styled for it).
const C = {
  card: "#0b1220",
  cardBdr: "#334155",
  text: "#F1F5F9",
  textMuted: "#94A3B8",
  textSub: "#CBD5E1",
  insert: "#10B981",
  update: "#3B82F6",
  delete: "#EF4444",
  void: "#EF4444",
  post: "#F59E0B",
  reverse: "#EF4444",
};

function opColor(op: RowChange["operation"]): string {
  switch (op) {
    case "INSERT":  return C.insert;
    case "UPDATE":  return C.update;
    case "DELETE":  return C.delete;
    case "VOID":    return C.void;
    case "POST":    return C.post;
    case "REVERSE": return C.reverse;
    default:        return C.textMuted;
  }
}

/**
 * Pure: produce an English relative-time string for a timestamp. Used
 * by the timeline to render "3m ago" / "2h ago" / etc. Exported so we
 * can unit-test the math without re-rendering.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diffMs = Math.max(0, now - t);
  const sec = Math.floor(diffMs / 1000);
  if (sec < 5)    return "just now";
  if (sec < 60)   return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60)   return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24)    return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30)   return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12)    return `${mo}mo ago`;
  const yr = Math.floor(mo / 12);
  return `${yr}y ago`;
}

/**
 * Compact a JSON-blob preview to a single-line summary string. Drops
 * sql-noise columns + caps the visible key set. Used for the
 * before/after pane in the expanded row.
 */
export function summarizeJsonb(
  blob: Record<string, unknown> | null,
  cap = 6,
): string {
  if (!blob || typeof blob !== "object") return "—";
  const noise = new Set(["updated_at", "synced_at", "search_doc", "id"]);
  const keys = Object.keys(blob).filter((k) => !noise.has(k));
  const shown = keys.slice(0, cap);
  const parts = shown.map((k) => {
    const v = (blob as Record<string, unknown>)[k];
    let s: string;
    if (v == null) s = "null";
    else if (typeof v === "object") s = JSON.stringify(v).slice(0, 30);
    else s = String(v).slice(0, 30);
    return `${k}=${s}`;
  });
  if (keys.length > cap) parts.push(`+${keys.length - cap} more`);
  return parts.join(", ") || "—";
}

export default function RowHistory({ source_table, source_id, endpoint }: Props) {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setData(null);
    setExpanded(null);
    const url = `${endpoint || "/api/internal/audit/row-history"}?source_table=${encodeURIComponent(source_table)}&source_id=${encodeURIComponent(source_id)}&limit=100`;
    (async () => {
      try {
        const r = await fetch(url);
        if (!r.ok) {
          const body = await r.json().catch(() => ({} as { error?: string }));
          throw new Error(body.error || `HTTP ${r.status}`);
        }
        const j = (await r.json()) as Resp;
        if (!cancelled) setData(j);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [source_table, source_id, endpoint]);

  const count = data?.count ?? 0;

  const header = useMemo(() => {
    if (loading) return "Audit trail — loading…";
    if (err) return "Audit trail — error";
    if (count === 0) return "No audit history";
    return `Audit trail — ${count} change${count === 1 ? "" : "s"}`;
  }, [loading, err, count]);

  return (
    <div data-testid="row-history" style={{ marginTop: 12 }}>
      <div
        style={{
          fontSize: 11,
          color: C.textMuted,
          marginBottom: 6,
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {header}
      </div>

      <div
        style={{
          background: C.card,
          border: `1px solid ${C.cardBdr}`,
          borderRadius: 8,
          padding: 10,
          fontSize: 12,
          color: C.text,
        }}
      >
        {loading && (
          <div style={{ color: C.textMuted, padding: "4px 2px" }}>Loading…</div>
        )}

        {err && (
          <div
            data-testid="row-history-error"
            style={{
              background: "#7f1d1d",
              color: "white",
              padding: "6px 10px",
              borderRadius: 6,
            }}
          >
            {err}
          </div>
        )}

        {!loading && !err && count === 0 && (
          <div data-testid="row-history-empty" style={{ color: C.textMuted }}>
            No audit history.
            <span style={{ marginLeft: 6, fontSize: 11 }}>
              T11 universal-audit coverage rolled out 2026-05-29; changes prior
              to that aren&apos;t recorded.
            </span>
          </div>
        )}

        {!loading && !err && (data?.changes || []).map((c) => {
          const isOpen = expanded === c.id;
          return (
            <div
              key={c.id}
              data-testid="row-history-row"
              data-row-id={c.id}
              style={{
                padding: "6px 4px",
                borderBottom: `1px solid ${C.cardBdr}`,
                cursor: "pointer",
              }}
              onClick={() => setExpanded(isOpen ? null : c.id)}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <span
                  data-testid="row-history-op-badge"
                  style={{
                    background: opColor(c.operation),
                    color: "white",
                    padding: "2px 6px",
                    borderRadius: 4,
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: 0.5,
                  }}
                >
                  {c.operation}
                </span>
                <span style={{ color: C.textSub, fontWeight: 600 }}>
                  {c.actor_display_name || "—"}
                </span>
                {c.reason && (
                  <span style={{ color: C.textMuted, fontStyle: "italic" }}>
                    &ldquo;{c.reason}&rdquo;
                  </span>
                )}
                {c.source && (
                  <span
                    style={{
                      color: C.textMuted,
                      fontSize: 11,
                      border: `1px solid ${C.cardBdr}`,
                      borderRadius: 4,
                      padding: "1px 5px",
                    }}
                  >
                    {c.source}
                  </span>
                )}
                <span
                  style={{
                    marginLeft: "auto",
                    color: C.textMuted,
                    fontSize: 11,
                  }}
                  title={new Date(c.changed_at).toLocaleString()}
                >
                  {relativeTime(c.changed_at)}
                </span>
              </div>

              {isOpen && (
                <div
                  data-testid="row-history-expanded"
                  style={{
                    marginTop: 8,
                    padding: 8,
                    background: "#070b14",
                    border: `1px solid ${C.cardBdr}`,
                    borderRadius: 6,
                  }}
                >
                  {c.changed_columns.length > 0 && (
                    <div style={{ marginBottom: 6 }}>
                      <span
                        style={{
                          color: C.textMuted,
                          fontSize: 10,
                          textTransform: "uppercase",
                          marginRight: 6,
                        }}
                      >
                        Columns changed:
                      </span>
                      {c.changed_columns.map((col) => (
                        <span
                          key={col}
                          style={{
                            display: "inline-block",
                            margin: "2px 4px 2px 0",
                            padding: "1px 6px",
                            background: "#1e293b",
                            color: C.textSub,
                            borderRadius: 4,
                            fontSize: 11,
                          }}
                        >
                          {col}
                        </span>
                      ))}
                    </div>
                  )}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: 8,
                      fontSize: 11,
                      fontFamily: "SFMono-Regular, Menlo, monospace",
                    }}
                  >
                    <div>
                      <div style={{ color: C.textMuted, marginBottom: 2 }}>before</div>
                      <div style={{ color: C.textSub, wordBreak: "break-all" }}>
                        {summarizeJsonb(c.before_jsonb)}
                      </div>
                    </div>
                    <div>
                      <div style={{ color: C.textMuted, marginBottom: 2 }}>after</div>
                      <div style={{ color: C.textSub, wordBreak: "break-all" }}>
                        {summarizeJsonb(c.after_jsonb)}
                      </div>
                    </div>
                  </div>
                  {c.correlation_id && (
                    <div
                      style={{
                        marginTop: 6,
                        color: C.textMuted,
                        fontSize: 10,
                        fontFamily: "SFMono-Regular, Menlo, monospace",
                      }}
                    >
                      correlation: {c.correlation_id}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
