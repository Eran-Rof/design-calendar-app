// Shared RFQ quote-comparison + message-thread components.
//
// Both the Tanda internal RFQ detail (src/tanda/InternalRfqDetail.tsx) and
// the Costing RFQ editor (src/costing/views/RfqEditView.tsx) need to surface
// the SAME vendor data: the submitted quote comparison (with vendor notes,
// quote-level + per-line) and the internal RFQ message thread. These two
// screens have slightly different palettes, so each component takes a small
// `theme` prop (RfqTheme) and is otherwise theme-neutral — the look is driven
// entirely by the caller's tokens.
//
// APIs (already exist, no backend change):
//   GET  /api/internal/rfqs/:id/quotes?sort=...   → Quote[]
//   GET  /api/internal/rfqs/:id/messages          → RfqMessage[]
//   POST /api/internal/rfqs/:id/messages          { body, sender_name }

import { useEffect, useRef, useState } from "react";
import SearchableSelect from "../components/SearchableSelect";

export interface RfqTheme {
  bg: string;        // page / recessed background
  card: string;      // panel background
  cardBdr: string;   // borders
  text: string;      // primary text
  textMuted: string; // labels / de-emphasised
  textSub: string;   // secondary body text
  primary: string;   // accent / internal bubble
  success: string;
  warn: string;
  danger: string;
}

export interface QuoteLine {
  id: string;
  rfq_line_item_id: string | null;
  unit_price: number | null;
  quantity: number | null;
  notes: string | null;
}

export interface QuoteRevisionSnapshot {
  total_price: number | null;
  lead_time_days: number | null;
  valid_until: string | null;
  notes: string | null;
  lines: { rfq_line_item_id: string | null; unit_price: number | null; quantity: number | null; notes: string | null }[];
}

export interface QuoteRevision {
  id: string;
  quote_id: string;
  revision: number;
  snapshot: QuoteRevisionSnapshot;
  submitted_at: string | null;
  created_at: string | null;
}

export interface Quote {
  id: string;
  vendor_id: string;
  vendor_name: string | null;
  status: string;
  total_price: number | null;
  lead_time_days: number | null;
  valid_until: string | null;
  notes: string | null;
  submitted_at: string | null;
  health_score: number;
  revision?: number | null;
  revisions?: QuoteRevision[];
  lines: QuoteLine[];
}

export type QuoteSortKey = "price" | "lead_time" | "health";

function statusColor(s: string, t: RfqTheme) {
  if (s === "awarded") return t.success;
  if (s === "submitted" || s === "under_review") return t.primary;
  if (s === "rejected") return t.danger;
  return t.textSub;
}

const GRID_COLS_WITH_ACTION = "1.4fr 130px 120px 110px 100px 140px 160px";
const GRID_COLS_NO_ACTION = "1.4fr 130px 120px 110px 100px 140px";

/**
 * Vendor quote comparison grid with an expandable per-quote notes view
 * (quote-level + per-line notes). Owns its own fetch against
 * /api/internal/rfqs/:id/quotes.
 *
 * - `sort` / `onSortChange`: when both provided, renders the sort selector and
 *   refetches on change. Omit both to hide the selector (defaults to "price").
 * - `onAward`: when provided, renders an Award action column for submitted
 *   quotes (Tanda detail). Omit for a display-only comparison (Costing editor).
 * - `lineLabel`: resolves an rfq_line_item_id to a human label for line notes.
 * - `reloadKey`: bump to force a refetch (e.g. after an award elsewhere).
 */
export function RfqQuotesPanel({
  rfqId,
  theme,
  sort,
  onSortChange,
  onAward,
  isAwarded,
  lineLabel,
  reloadKey,
  onRevisionsDetected,
}: {
  rfqId: string;
  theme: RfqTheme;
  sort?: QuoteSortKey;
  onSortChange?: (s: QuoteSortKey) => void;
  onAward?: (vendorId: string, vendorName: string) => void;
  isAwarded?: boolean;
  lineLabel?: (lineItemId: string | null) => string;
  reloadKey?: unknown;
  /** Called after quotes load with any vendor quotes that have been revised
   *  (revision > 1), so the host can surface a "vendor revised" alert. */
  onRevisionsDetected?: (info: { revisedVendors: { vendor_name: string; revision: number }[]; maxRevision: number }) => void;
}) {
  const C = theme;
  const effSort: QuoteSortKey = sort ?? "price";
  const showSort = sort !== undefined && !!onSortChange;
  const showAction = !!onAward;
  const cols = showAction ? GRID_COLS_WITH_ACTION : GRID_COLS_NO_ACTION;

  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Keep the latest callback without making it an effect dependency (the
  // parent may pass a fresh function each render).
  const onRevRef = useRef(onRevisionsDetected);
  onRevRef.current = onRevisionsDetected;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    fetch(`/api/internal/rfqs/${rfqId}/quotes?sort=${effSort}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
      .then((q) => {
        if (cancelled) return;
        const list = q as Quote[];
        setQuotes(list);
        const revisedVendors = list
          .filter((x) => (x.revision ?? 1) > 1)
          .map((x) => ({ vendor_name: x.vendor_name || "A vendor", revision: x.revision ?? 1 }));
        const maxRevision = revisedVendors.reduce((m, r) => Math.max(m, r.revision), 1);
        onRevRef.current?.({ revisedVendors, maxRevision });
      })
      .catch((e: unknown) => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [rfqId, effSort, reloadKey]);

  function downloadCsv() {
    const headers = ["Vendor", "Status", "Total price", "Lead time (days)", "Valid until", "Health score", "Submitted at"];
    const rows = quotes.map((q) => [
      q.vendor_name || "",
      q.status,
      q.total_price != null ? String(q.total_price) : "",
      q.lead_time_days != null ? String(q.lead_time_days) : "",
      q.valid_until || "",
      String(q.health_score),
      q.submitted_at || "",
    ]);
    const csv = [headers, ...rows].map((r) => r.map((v) => /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `rfq-${rfqId}-quotes.csv`; a.click(); URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", marginBottom: 10 }}>
        <h3 style={{ fontSize: 15, margin: 0, color: C.text }}>Quote comparison ({quotes.length})</h3>
        <button onClick={downloadCsv} style={{ marginLeft: "auto", padding: "5px 12px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}>CSV</button>
        {showSort && (
          <>
            <div style={{ color: C.textMuted, fontSize: 12 }}>Sort:</div>
            <div style={{ width: 170 }}>
              <SearchableSelect
                value={effSort}
                onChange={(v) => onSortChange!(v as QuoteSortKey)}
                options={[
                  { value: "price", label: "Lowest price" },
                  { value: "lead_time", label: "Fastest lead time" },
                  { value: "health", label: "Highest health" },
                ]}
                inputStyle={{ padding: "5px 8px", background: C.card, border: `1px solid ${C.cardBdr}`, color: C.text, borderRadius: 6, fontSize: 12 }}
              />
            </div>
          </>
        )}
      </div>

      {err && <div style={{ color: C.danger, fontSize: 12, marginBottom: 8 }}>Error: {err}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: cols, padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
          <div>Vendor</div>
          <div style={{ textAlign: "right" }}>Total</div>
          <div style={{ textAlign: "right" }}>Lead time</div>
          <div style={{ textAlign: "right" }}>Health</div>
          <div>Status</div>
          <div>Submitted</div>
          {showAction && <div style={{ textAlign: "right" }}>Action</div>}
        </div>
        {loading ? (
          <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13 }}>Loading…</div>
        ) : quotes.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13 }}>No quotes yet.</div>
        ) : quotes.map((q) => {
          const lineNotes = (q.lines || []).filter((l) => l.notes && l.notes.trim());
          const revisions = (q.revisions || []).slice().sort((a, b) => b.revision - a.revision);
          const isRevised = (q.revision ?? 1) > 1 && revisions.length > 0;
          const hasNotes = !!(q.notes && q.notes.trim()) || lineNotes.length > 0;
          const canExpand = hasNotes || isRevised;
          const isOpen = !!expanded[q.id];
          return (
            <div key={q.id}>
              <div style={{ display: "grid", gridTemplateColumns: cols, padding: "10px 14px", borderBottom: isOpen ? "none" : `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center", color: C.text }}>
                <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  {canExpand && (
                    <span
                      onClick={() => setExpanded((p) => ({ ...p, [q.id]: !p[q.id] }))}
                      title={isOpen ? "Hide details" : (isRevised ? "Show revision history + vendor notes" : "Show vendor notes")}
                      style={{ cursor: "pointer", color: C.primary, fontSize: 11, userSelect: "none" }}
                    >
                      {isOpen ? "▾" : "▸"} {hasNotes ? "notes" : "pending"}
                    </span>
                  )}
                  {q.vendor_name || "—"}
                  {isRevised && (
                    <span
                      title={`This vendor revised their quote ${(q.revision ?? 1) - 1} time(s)`}
                      style={{ background: C.warn, color: "#1A1205", borderRadius: 4, padding: "1px 6px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.03 }}
                    >
                      Revised v{q.revision}
                    </span>
                  )}
                </div>
                <div style={{ textAlign: "right" }}>{q.total_price != null ? `$${Number(q.total_price).toLocaleString()}` : "—"}</div>
                <div style={{ textAlign: "right", color: C.textSub }}>{q.lead_time_days != null ? `${q.lead_time_days}d` : "—"}</div>
                <div style={{ textAlign: "right", color: q.health_score >= 80 ? C.success : q.health_score >= 60 ? C.warn : C.danger, fontWeight: 700 }}>{q.health_score}</div>
                <div style={{ color: statusColor(q.status, C), fontWeight: 600, fontSize: 11, textTransform: "uppercase" }}>{q.status}</div>
                <div style={{ color: C.textMuted, fontSize: 11 }}>{q.submitted_at ? q.submitted_at.slice(0, 10) : "—"}</div>
                {showAction && (
                  <div style={{ textAlign: "right" }}>
                    {!isAwarded && q.status === "submitted" && (
                      <button onClick={() => onAward!(q.vendor_id, q.vendor_name || q.vendor_id)} style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: C.success, color: "#FFFFFF", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}>Award</button>
                    )}
                    {isAwarded && q.status === "awarded" && <span style={{ color: C.success, fontSize: 12, fontWeight: 700 }}>✓ Awarded</span>}
                  </div>
                )}
              </div>
              {isOpen && canExpand && (
                <div style={{ padding: "10px 16px 14px", borderBottom: `1px solid ${C.cardBdr}`, background: C.bg }}>
                  {isRevised && (
                    <div style={{ marginBottom: hasNotes ? 12 : 0 }}>
                      <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", fontWeight: 700, marginBottom: 6 }}>Revision history — current vs. prior</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {/* Current (live) values */}
                        <RevisionRow
                          C={C}
                          label={`v${q.revision} (current)`}
                          when={q.submitted_at}
                          whenLabel="submitted"
                          totalPrice={q.total_price}
                          leadTime={q.lead_time_days}
                          validUntil={q.valid_until}
                          lines={q.lines}
                          lineLabel={lineLabel}
                          highlight
                        />
                        {/* Prior revisions, newest first */}
                        {revisions.map((rev) => (
                          <RevisionRow
                            key={rev.id}
                            C={C}
                            label={`v${rev.revision}`}
                            when={rev.submitted_at}
                            whenLabel="submitted"
                            totalPrice={rev.snapshot?.total_price ?? null}
                            leadTime={rev.snapshot?.lead_time_days ?? null}
                            validUntil={rev.snapshot?.valid_until ?? null}
                            lines={(rev.snapshot?.lines || []).map((l, i) => ({ id: `${rev.id}-${i}`, ...l }))}
                            lineLabel={lineLabel}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                  {q.notes && q.notes.trim() && (
                    <div style={{ marginBottom: lineNotes.length ? 10 : 0 }}>
                      <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", fontWeight: 700, marginBottom: 3 }}>Quote note</div>
                      <div style={{ fontSize: 12, color: C.textSub, whiteSpace: "pre-wrap", lineHeight: 1.4 }}>{q.notes}</div>
                    </div>
                  )}
                  {lineNotes.length > 0 && (
                    <div>
                      <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", fontWeight: 700, marginBottom: 4 }}>Line notes</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        {lineNotes.map((l) => {
                          const label = lineLabel ? lineLabel(l.rfq_line_item_id) : "Line";
                          return (
                            <div key={l.id} style={{ fontSize: 12, color: C.textSub, lineHeight: 1.4 }}>
                              <span style={{ color: C.textMuted }}>{label}:</span> {l.notes}
                            </div>
                          );
                        })}
                      </div>
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

// One row in the revision-history block: a version's total / lead-time /
// valid-until + per-line prices, with the date it was submitted. The "current"
// row is highlighted so the operator reads old vs new at a glance.
function RevisionRow({
  C, label, when, whenLabel, totalPrice, leadTime, validUntil, lines, lineLabel, highlight,
}: {
  C: RfqTheme;
  label: string;
  when: string | null;
  whenLabel: string;
  totalPrice: number | null;
  leadTime: number | null;
  validUntil: string | null;
  lines: { id: string; rfq_line_item_id: string | null; unit_price: number | null; quantity: number | null; notes: string | null }[];
  lineLabel?: (lineItemId: string | null) => string;
  highlight?: boolean;
}) {
  const priced = (lines || []).filter((l) => l.unit_price != null);
  return (
    <div style={{ border: `1px solid ${highlight ? C.primary : C.cardBdr}`, borderRadius: 6, padding: "8px 10px", background: C.card }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: highlight ? C.primary : C.text }}>{label}</span>
        <span style={{ fontSize: 11, color: C.textMuted }}>{whenLabel} {when ? new Date(when).toLocaleString() : "—"}</span>
        <span style={{ marginLeft: "auto", fontSize: 12, color: C.text }}>
          Total <b>{totalPrice != null ? `$${Number(totalPrice).toLocaleString()}` : "—"}</b>
          {" · "}Lead <b>{leadTime != null ? `${leadTime}d` : "—"}</b>
          {" · "}Valid until <b>{validUntil ? String(validUntil).slice(0, 10) : "—"}</b>
        </span>
      </div>
      {priced.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 14px", marginTop: 6 }}>
          {priced.map((l) => {
            const lbl = lineLabel ? lineLabel(l.rfq_line_item_id) : "Line";
            return (
              <span key={l.id} style={{ fontSize: 11, color: C.textSub }}>
                <span style={{ color: C.textMuted }}>{lbl}:</span> ${Number(l.unit_price).toLocaleString()}{l.quantity != null ? ` ×${Number(l.quantity).toLocaleString()}` : ""}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface Attachment {
  name: string;
  type: string;
  size: number;
  url: string;
}
interface RfqMessage {
  id: string;
  sender_type: string;
  sender_name: string;
  body: string;
  created_at: string;
  attachments?: Attachment[];
}

/**
 * Internal-side RFQ message thread, scoped to ONE vendor (private 1:1).
 * Threads are per (rfq, vendor): the buyer reads that vendor's messages and
 * replies as "Ring of Fire". Talks to /api/internal/rfqs/:id/messages with a
 * required vendor_id (the rfq_messages table is service-role only). Internal
 * replies right-aligned, vendor messages left-aligned.
 */
export function RfqMessageThread({ rfqId, vendorId, theme, onPosted }: { rfqId: string; vendorId: string; theme: RfqTheme; onPosted?: () => void }) {
  const C = theme;
  const [messages, setMessages] = useState<RfqMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/rfqs/${rfqId}/messages?vendor_id=${encodeURIComponent(vendorId)}`);
      if (!r.ok) throw new Error(await r.text());
      const raw = await r.json();
      setMessages(Array.isArray(raw) ? raw as RfqMessage[] : []);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [rfqId, vendorId]);

  function pickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files || []);
    const tooBig = picked.filter(f => f.size > 15_728_640);
    const valid = picked.filter(f => f.size <= 15_728_640);
    if (tooBig.length > 0) setErr(`${tooBig.map(f => f.name).join(", ")} exceed${tooBig.length === 1 ? "s" : ""} the 15 MB limit and ${tooBig.length === 1 ? "was" : "were"} not attached.`);
    setPendingFiles(p => [...p, ...valid].slice(0, 5));
    e.target.value = "";
  }

  async function send() {
    const body = draft.trim();
    if (!body && pendingFiles.length === 0) return;
    setSending(true);
    setUploading(pendingFiles.length > 0);
    setErr(null);
    try {
      let attachments: { name: string; type: string; size: number; data: string }[] = [];
      if (pendingFiles.length > 0) {
        attachments = await Promise.all(pendingFiles.map(f => new Promise<{ name: string; type: string; size: number; data: string }>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve({ name: f.name, type: f.type, size: f.size, data: reader.result as string });
          reader.onerror = reject;
          reader.readAsDataURL(f);
        })));
      }
      const r = await fetch(`/api/internal/rfqs/${rfqId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, vendor_id: vendorId, sender_name: "Ring of Fire", attachments }),
      });
      if (!r.ok) throw new Error(await r.text());
      setDraft("");
      setPendingFiles([]);
      await load();
      onPosted?.();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setSending(false); setUploading(false); }
  }

  return (
    <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, marginTop: 16, overflow: "hidden" }}>
      <div style={{ padding: "12px 16px", background: C.bg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 14, fontWeight: 700, color: C.text }}>Messages</div>
      <div style={{ maxHeight: 320, overflowY: "auto", padding: "12px 16px" }}>
        {loading ? (
          <div style={{ color: C.textMuted, fontSize: 13 }}>Loading…</div>
        ) : messages.length === 0 ? (
          <div style={{ color: C.textMuted, fontSize: 13, textAlign: "center", padding: "30px 0" }}>No messages yet. Reply to a vendor or start the conversation below.</div>
        ) : messages.map((m) => {
          const mine = m.sender_type === "internal";
          return (
            <div key={m.id} style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start", marginBottom: 10 }}>
              <div style={{ maxWidth: "78%", background: mine ? C.primary : C.bg, color: C.text, border: `1px solid ${mine ? C.primary : C.cardBdr}`, borderRadius: 10, padding: "8px 12px", fontSize: 13 }}>
                <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 4, opacity: 0.85, color: mine ? "rgba(255,255,255,0.9)" : C.textMuted }}>
                  {m.sender_name}
                </div>
                <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.4 }}>{m.body}</div>
                {(m.attachments || []).length > 0 && (
                  <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                    {(m.attachments || []).map((a, i) => (
                      a.type.startsWith("image/") ? (
                        <a key={i} href={a.url} target="_blank" rel="noopener noreferrer">
                          <img src={a.url} alt={a.name} style={{ maxWidth: 200, maxHeight: 200, borderRadius: 6, display: "block" }} />
                        </a>
                      ) : (
                        <a key={i} href={a.url} target="_blank" rel="noopener noreferrer" style={{ color: mine ? "rgba(255,255,255,0.9)" : C.primary, fontSize: 12, display: "flex", alignItems: "center", gap: 4, textDecoration: "none" }}>
                          {a.name}
                        </a>
                      )
                    ))}
                  </div>
                )}
                <div style={{ fontSize: 10, marginTop: 4, opacity: 0.7 }}>{new Date(m.created_at).toLocaleString()}</div>
              </div>
            </div>
          );
        })}
      </div>
      {err && <div style={{ padding: "6px 16px", color: C.danger, fontSize: 12 }}>{err}</div>}
      <div style={{ borderTop: `1px solid ${C.cardBdr}` }}>
        <div style={{ padding: "10px 16px 0", display: "flex", gap: 8 }}>
          <textarea
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}
            placeholder="Reply to the vendor…"
            style={{ flex: 1, padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.bg, color: C.text, fontSize: 13, fontFamily: "inherit", resize: "vertical" }}
          />
        </div>
        {pendingFiles.length > 0 && (
          <div style={{ padding: "4px 16px", display: "flex", flexWrap: "wrap", gap: 6 }}>
            {pendingFiles.map((f, i) => (
              <span key={i} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 14, padding: "3px 10px", fontSize: 11, color: C.text, display: "flex", alignItems: "center", gap: 6 }}>
                {f.name}
                <span onClick={() => setPendingFiles(p => p.filter((_, j) => j !== i))} style={{ cursor: "pointer", color: C.textMuted, fontWeight: 700 }}>×</span>
              </span>
            ))}
          </div>
        )}
        <div style={{ padding: "6px 16px 10px", display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <input ref={fileInputRef} type="file" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.zip,.txt" style={{ display: "none" }} onChange={pickFiles} />
          <button onClick={() => fileInputRef.current?.click()} title="Attach file" style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: "transparent", color: C.textMuted, cursor: "pointer", fontSize: 12, lineHeight: 1 }}>
            Attach
          </button>
          <button onClick={() => void send()} disabled={sending || (!draft.trim() && pendingFiles.length === 0)} style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", fontSize: 12, fontWeight: 600, fontFamily: "inherit", opacity: sending || (!draft.trim() && pendingFiles.length === 0) ? 0.5 : 1, cursor: sending || (!draft.trim() && pendingFiles.length === 0) ? "not-allowed" : "pointer" }}>
            {uploading ? "Uploading…" : sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Per-RFQ message panel for the internal side. Threads are now PRIVATE per
 * vendor, so this renders a vendor selector (the RFQ's invited vendors) above
 * the thread; picking a vendor shows that vendor's 1:1 conversation. Defaults
 * to the first invited vendor; shows an empty state when the RFQ has no
 * invitations (nothing to message until it's sent).
 */
export function RfqVendorThreadPanel({
  rfqId,
  vendors,
  theme,
  onPosted,
}: {
  rfqId: string;
  vendors: { vendor_id: string; vendor_name: string }[];
  theme: RfqTheme;
  onPosted?: () => void;
}) {
  const C = theme;
  const [vendorId, setVendorId] = useState<string>(vendors[0]?.vendor_id ?? "");
  useEffect(() => {
    // Keep selection valid as the invited-vendor list changes (e.g. after send).
    if (vendors.length === 0) { if (vendorId) setVendorId(""); return; }
    if (!vendors.some((v) => v.vendor_id === vendorId)) setVendorId(vendors[0].vendor_id);
  }, [vendors, vendorId]);

  if (vendors.length === 0) {
    return (
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, marginTop: 16, padding: "20px 16px", color: C.textMuted, fontSize: 13 }}>
        <div style={{ fontWeight: 700, color: C.text, marginBottom: 6 }}>Messages</div>
        No vendors invited yet. Send this RFQ to a vendor to start a private conversation with them.
      </div>
    );
  }

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, color: C.textMuted, fontWeight: 600 }}>Conversation with:</span>
        <div style={{ minWidth: 220 }}>
          <SearchableSelect
            value={vendorId || null}
            onChange={(v) => setVendorId(v)}
            options={vendors.map((v) => ({ value: v.vendor_id, label: v.vendor_name }))}
            inputStyle={{ padding: "5px 8px", background: C.card, border: `1px solid ${C.cardBdr}`, color: C.text, borderRadius: 6, fontSize: 12, fontFamily: "inherit" }}
          />
        </div>
      </div>
      {vendorId && (
        <RfqMessageThread key={vendorId} rfqId={rfqId} vendorId={vendorId} theme={C} onPosted={onPosted} />
      )}
    </div>
  );
}
