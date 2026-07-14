// src/tanda/components/JEDetailModal.tsx
//
// Tangerine — shared Journal Entry detail modal.
//
// Extracted from InternalJournalEntry.tsx so the SAME read-only-with-reverse JE
// view can be opened from two places:
//   • the Journal Entries module (row click)
//   • the GL Detail drill-down (double-click a ledger line -> open its full JE)
//
// The modal self-fetches the full JE (header + all lines) by id from
//   GET /api/internal/journal-entries/:id
// so callers only need to seed a minimal { id, description, status } stub.
//
// Posted JEs are immutable by design — "edit" of a posted entry is the
// Reverse/adjust affordance (audit-safe). Drafts surface as such. This modal
// therefore exposes the module's existing Reverse control via onReverseClick;
// it never bypasses the posting/audit rules with a direct edit.
//
// No raw UUIDs surface: lines resolve to account code + name, the header shows
// description / posting date / status / basis — never id.slice.

import React, { useEffect, useMemo, useState } from "react";
import DocumentAttachmentList from "../../shared/documents/DocumentAttachmentList";
import RowHistory from "./RowHistory";
import { fmtDateDisplay } from "../../utils/tandaTypes";
import { drillToModule, type DrillModuleKey } from "../scorecardDrill";
import SourceDocumentModal, { type SourceDocOpen } from "./SourceDocumentModal";

// A source document reachable from this JE (invoice / bill / receipt / …).
// AR/AP docs also carry id + docType + party so they open in place (the
// QuickBooks-style document viewer) rather than only navigating to a list.
type SourceDocRef = {
  kind: string;
  number: string | null;
  module: DrillModuleKey | string | null;
  q: string | null;
  leg?: string | null;
  id?: string | null;
  docType?: "ar" | "ap" | null;
  party?: string | null;
};
type SourceDocResult = {
  label: string;
  module: string | null;
  q: string | null;
  docs?: SourceDocRef[];
  count?: number;
  truncated?: boolean;
};

// Minimal seed the modal needs before its own fetch resolves. Both the JE list
// (full JE row) and the GL-detail line (je_id + description) can satisfy this.
export type JEDetailSeed = {
  id: string;
  je_number?: string | null;
  description?: string | null;
  status?: "draft" | "posted" | "reversed" | null;
};

type Account = {
  id: string;
  code: string;
  name: string;
};

type JELineRow = {
  id: string;
  journal_entry_id: string;
  line_number: number;
  account_id: string;
  debit: string;
  credit: string;
  memo: string | null;
  memo_line_2: string | null;
  subledger_type: string | null;
  subledger_id: string | null;
};

type JEFull = {
  id: string;
  je_number: string | null;
  basis: "ACCRUAL" | "CASH";
  journal_type: string;
  posting_date: string;
  source_module: string | null;
  source_table: string | null;
  source_id: string | null;
  description: string;
  status: "draft" | "posted" | "reversed";
  posted_at: string | null;
  sibling_je_id: string | null;
  reverses_je_id: string | null;
  reversed_by_je_id: string | null;
  sibling_je_number?: string | null;
  reverses_je_number?: string | null;
  reversed_by_je_number?: string | null;
  created_at: string;
  posted_by_name?: string | null;
  created_by_name?: string | null;
  lines: JELineRow[];
};

const C = {
  card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  success: "#10B981", danger: "#EF4444",
};

const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13,
};
const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const btnDanger: React.CSSProperties = { ...btnSecondary, color: C.danger, borderColor: "#7f1d1d" };

export function jeStatusColor(s: JEFull["status"] | "draft" | "posted" | "reversed") {
  return s === "posted" ? C.success : s === "draft" ? C.textMuted : C.danger;
}

type ApprovalStep = {
  id: string;
  step_order: number;
  mode: "any" | "all";
  role_required: string;
  fulfilled_at: string | null;
  fulfilled_by_user_id: string | null;
  notes: string | null;
};

type ApprovalRequest = {
  id: string;
  entity_id: string;
  kind: string;
  context_table: string;
  context_id: string;
  status: "pending" | "approved" | "rejected" | "cancelled" | "expired";
  final_decided_at: string | null;
  created_at: string;
  steps: ApprovalStep[];
};

// Drill-through: a related-entry number rendered as an in-modal jump link.
function JeJumpLink({ id, label, onJump }: { id: string; label: string; onJump: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onJump(id)}
      title="Open this related entry"
      style={{ background: "transparent", border: "none", color: "#3B82F6", cursor: "pointer", padding: 0, fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 13, textDecoration: "underline" }}>
      {label}
    </button>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 2, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div>{value}</div>
    </div>
  );
}

export default function JEDetailModal({
  je, onClose, onReversed: _onReversed, onReverseClick,
}: {
  je: JEDetailSeed;
  onClose: () => void;
  onReversed: () => void;
  // When provided, a Reverse button is shown for posted, not-yet-reversed JEs.
  // Callers that cannot reverse (or don't want to) may omit it.
  onReverseClick?: (je: JEFull) => void;
}) {
  const [data, setData] = useState<JEFull | null>(null);
  const [accounts, setAccounts] = useState<Record<string, Account>>({});
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Drill-through: in-modal jump to a RELATED entry (sibling / reverses /
  // reversed-by) — the fetch keys on jumpId || je.id, so clicking a related
  // number re-loads the modal in place instead of dead-ending.
  const [jumpId, setJumpId] = useState<string | null>(null);
  const jeId = jumpId || je.id;
  // Drill-through: the JE's source document(s), resolved server-side. For a
  // GL-mirror JE the resolver runs the reverse lookup (invoices/bills that point
  // at this JE): one doc → module/q set; many (a payment settling N invoices) →
  // docs[] for the picker; none → an un-linked "no source document" label.
  const [srcDoc, setSrcDoc] = useState<SourceDocResult | null>(null);
  // When a multi-doc JE is expanded, the picker list is shown inline.
  const [showDocPicker, setShowDocPicker] = useState(false);
  // QuickBooks-style: the actual invoice/bill opened IN PLACE (over this modal).
  const [docOpen, setDocOpen] = useState<SourceDocOpen | null>(null);

  // Open an AR/AP document in the in-place viewer when we have its id; otherwise
  // fall back to navigating the owning list module (receipts, adjustments, …).
  function openSourceDoc(d: SourceDocRef) {
    if (d.id && (d.docType === "ar" || d.docType === "ap")) {
      setDocOpen({ docType: d.docType, id: d.id, number: d.number, party: d.party, module: d.module as string | null });
      return;
    }
    if (d.module && d.q) { onClose(); drillToModule(d.module as DrillModuleKey, { q: d.q }); }
  }

  useEffect(() => { setJumpId(null); }, [je.id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      setSrcDoc(null);
      setShowDocPicker(false);
      try {
        const r = await fetch(`/api/internal/journal-entries/${jeId}`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        const full = await r.json() as JEFull;
        if (cancelled) return;
        setData(full);

        // Look up account codes/names for the lines. COA is small.
        try {
          const ar = await fetch("/api/internal/gl-accounts?limit=1000");
          if (ar.ok) {
            const list = await ar.json() as Account[];
            if (!cancelled) {
              const idx: Record<string, Account> = {};
              for (const a of list) idx[a.id] = a;
              setAccounts(idx);
            }
          }
        } catch { /* non-fatal — lines fall back to "—" */ }

        // Best-effort source-document resolution (drill: JE → document).
        try {
          const sr = await fetch(`/api/internal/journal-entries/${jeId}/source`);
          if (sr.ok) {
            const s = await sr.json();
            if (!cancelled && s && s.label) setSrcDoc(s);
          }
        } catch { /* non-fatal — the Source row falls back to plain text */ }

        // Best-effort approval history.
        try {
          const params = new URLSearchParams();
          params.set("context_table", "journal_entries");
          params.set("context_id", jeId);
          const pr = await fetch(`/api/internal/approval-requests?${params.toString()}`);
          if (pr.ok) {
            const list = await pr.json() as ApprovalRequest[];
            if (!cancelled) setApprovals(Array.isArray(list) ? list : []);
          }
        } catch { /* non-fatal */ }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [jeId]);

  // Close on Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const totals = useMemo(() => {
    let d = 0, c = 0;
    for (const l of data?.lines || []) {
      const dn = parseFloat(l.debit || "0"); if (Number.isFinite(dn)) d += dn;
      const cn = parseFloat(l.credit || "0"); if (Number.isFinite(cn)) c += cn;
    }
    return { d, c };
  }, [data]);

  const canReverse = !!onReverseClick && data?.status === "posted" && !data?.reversed_by_je_id;
  const seedStatus = je.status || "posted";

  return (
    <>
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 1100, paddingTop: 40, paddingBottom: 40, overflowY: "auto" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(720px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 18 }}>
            {(data?.je_number || je.je_number)
              ? <span style={{ fontFamily: "SFMono-Regular, Menlo, monospace" }}>{data?.je_number || je.je_number}</span>
              : "Journal entry detail"}
            <span style={{ marginLeft: 10, fontSize: 12, color: C.textMuted }}>
              {data?.description || je.description || "—"}
            </span>
          </h3>
          <span style={{ color: jeStatusColor(data?.status || seedStatus), fontWeight: 600, fontSize: 13 }}>
            ● {data?.status || seedStatus}
          </span>
        </div>

        {loading && <div style={{ color: C.textMuted, fontSize: 13, padding: "12px 0" }}>Loading…</div>}

        {err && (
          <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
            {err}
          </div>
        )}

        {data && (
          <>
            {/* Header section */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16, fontSize: 13 }}>
              <DetailRow label="Posting date" value={fmtDateDisplay(data.posting_date)} />
              <DetailRow label="Journal type" value={data.journal_type} />
              <DetailRow label="Basis" value={<span style={{ fontFamily: "SFMono-Regular, Menlo, monospace" }}>{data.basis}</span>} />
              <DetailRow label="Source module" value={data.source_module || "—"} />
              <DetailRow
                label="Source document"
                value={(() => {
                  const docs = srcDoc?.docs || [];
                  // Many source documents (e.g. a payment settling N invoices):
                  // offer a picker instead of a single dead link.
                  if (srcDoc && docs.length > 1) {
                    return (
                      <div>
                        <button
                          type="button"
                          onClick={() => setShowDocPicker((v) => !v)}
                          title="This entry settles multiple documents — pick one to open"
                          style={{ background: "transparent", border: "none", color: "#3B82F6", cursor: "pointer", padding: 0, fontSize: 13, textDecoration: "underline" }}>
                          {srcDoc.label} {showDocPicker ? "▲" : "▾"}
                        </button>
                        {showDocPicker && (
                          <div style={{ marginTop: 6, maxHeight: 220, overflowY: "auto", border: `1px solid ${C.cardBdr}`, borderRadius: 6, background: "#0b1220" }}>
                            {docs.map((d, i) => (
                              <button
                                key={`${d.module}-${d.number}-${i}`}
                                type="button"
                                disabled={!d.module || !d.q}
                                onClick={() => openSourceDoc(d)}
                                title={d.id && (d.docType === "ar" || d.docType === "ap") ? "Open this document" : d.module && d.q ? "Open in the owning module" : "No panel for this document"}
                                style={{
                                  display: "flex", justifyContent: "space-between", gap: 10, width: "100%",
                                  background: "transparent", border: "none", borderBottom: `1px solid ${C.cardBdr}`,
                                  color: d.module && d.q ? "#3B82F6" : C.textMuted, cursor: d.module && d.q ? "pointer" : "default",
                                  padding: "6px 10px", fontSize: 12, textAlign: "left",
                                }}
                                onMouseEnter={(e) => { if (d.module && d.q) e.currentTarget.style.background = "#162033"; }}
                                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                              >
                                <span>{d.kind}{d.number ? ` ${d.number}` : ""}{d.party ? ` · ${d.party}` : ""}</span>
                                <span style={{ color: C.textMuted }}>{d.leg === "cash" ? "payment" : d.leg === "accrual" ? "accrual" : ""}</span>
                              </button>
                            ))}
                            {srcDoc.truncated && (
                              <div style={{ padding: "6px 10px", fontSize: 11, color: C.textMuted, fontStyle: "italic" }}>
                                Showing first {docs.length} of {srcDoc.count}. Open the AR/AP module to see the rest.
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  }
                  // Exactly one document — a direct link. AR/AP open the actual
                  // invoice/bill IN PLACE; anything else navigates its module.
                  if (srcDoc && srcDoc.module && srcDoc.q) {
                    const only = docs[0];
                    return (
                      <button
                        type="button"
                        onClick={() => { if (only) openSourceDoc(only); else { onClose(); drillToModule(srcDoc.module as DrillModuleKey, { q: srcDoc.q as string }); } }}
                        title="Open the document this entry was posted from"
                        style={{ background: "transparent", border: "none", color: "#3B82F6", cursor: "pointer", padding: 0, fontSize: 13, textDecoration: "underline" }}>
                        {srcDoc.label}{only?.party ? ` · ${only.party}` : ""}
                      </button>
                    );
                  }
                  // No document (payroll / adjustment / mfg mirror JE) — an
                  // un-linked label; the JE detail itself is the drill target.
                  if (srcDoc) return <span style={{ fontSize: 12 }}>{srcDoc.label}</span>;
                  return data.source_table ? <span style={{ fontSize: 12 }}>{data.source_table}</span> : "—";
                })()}
              />
              <DetailRow
                label="Posted at"
                value={data.posted_at
                  ? `${new Date(data.posted_at).toLocaleString()}${data.posted_by_name ? ` by ${data.posted_by_name}` : ""}`
                  : "—"}
              />
              <DetailRow
                label="Created"
                value={`${new Date(data.created_at).toLocaleString()}${data.created_by_name ? ` by ${data.created_by_name}` : ""}`}
              />
              <DetailRow
                label="Sibling JE"
                value={data.sibling_je_id
                  ? <JeJumpLink id={data.sibling_je_id} label={data.sibling_je_number || "Yes"} onJump={setJumpId} />
                  : "—"}
              />
              <DetailRow
                label="Reverses / reversed by"
                value={data.reverses_je_id
                  ? <>Reverses <JeJumpLink id={data.reverses_je_id} label={data.reverses_je_number || "another entry"} onJump={setJumpId} /></>
                  : data.reversed_by_je_id
                    ? <>Reversed by <JeJumpLink id={data.reversed_by_je_id} label={data.reversed_by_je_number || "another entry"} onJump={setJumpId} /></>
                    : "—"}
              />
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Description</div>
              <div style={{ fontSize: 13 }}>{data.description || "—"}</div>
            </div>

            {/* Lines section */}
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Lines</div>
            <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ ...th, width: 40 }}>#</th>
                    <th style={th}>Account</th>
                    <th style={{ ...th, width: 110, textAlign: "right" }}>Debit</th>
                    <th style={{ ...th, width: 110, textAlign: "right" }}>Credit</th>
                    <th style={th}>Memo</th>
                    <th style={{ ...th, width: 140 }}>Subledger</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.lines || []).map((l) => {
                    const acct = accounts[l.account_id];
                    return (
                      <tr key={l.id}>
                        <td style={td}>{l.line_number}</td>
                        <td style={{ ...td, fontSize: 12 }}>
                          {acct
                            ? <><span style={{ fontFamily: "SFMono-Regular, Menlo, monospace" }}>{acct.code}</span> — {acct.name}</>
                            : <span style={{ color: C.textMuted }}>—</span>}
                        </td>
                        <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", textAlign: "right" }}>
                          {parseFloat(l.debit || "0") > 0 ? parseFloat(l.debit).toFixed(2) : ""}
                        </td>
                        <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", textAlign: "right" }}>
                          {parseFloat(l.credit || "0") > 0 ? parseFloat(l.credit).toFixed(2) : ""}
                        </td>
                        <td style={{ ...td, fontSize: 12, color: C.textSub }}>
                          {l.memo || ""}
                          {l.memo_line_2 && l.memo_line_2 !== l.memo ? (
                            <div style={{ color: C.textMuted, fontSize: 11 }}>{l.memo_line_2}</div>
                          ) : null}
                        </td>
                        <td style={{ ...td, fontSize: 11, color: C.textMuted }}>
                          {l.subledger_type || ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ background: "#0b1220" }}>
                    <td style={td} colSpan={2}>
                      <span style={{ color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Totals</span>
                    </td>
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 700, textAlign: "right" }}>{totals.d.toFixed(2)}</td>
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 700, textAlign: "right" }}>{totals.c.toFixed(2)}</td>
                    <td style={td} colSpan={2}></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Approval history (optional, best-effort) */}
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Approval history</div>
            <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 10, marginBottom: 16, fontSize: 12 }}>
              {approvals.length === 0 ? (
                <div style={{ color: C.textMuted }}>No approval history.</div>
              ) : (
                approvals.map((a) => (
                  <div key={a.id} style={{ paddingBottom: 6, marginBottom: 6, borderBottom: `1px solid ${C.cardBdr}` }}>
                    <div>
                      <span style={{ color: jeStatusColor(a.status === "approved" ? "posted" : a.status === "rejected" ? "reversed" : "draft"), fontWeight: 600 }}>● {a.status}</span>
                      <span style={{ color: C.textMuted, marginLeft: 8 }}>
                        {a.kind} · created {fmtDateDisplay(a.created_at)}
                        {a.final_decided_at ? ` · decided ${fmtDateDisplay(a.final_decided_at)}` : ""}
                      </span>
                    </div>
                    {(a.steps || []).length > 0 && (
                      <div style={{ marginTop: 4, color: C.textSub, fontSize: 11 }}>
                        {a.steps.map((s) => (
                          <div key={s.id}>
                            step {s.step_order} ({s.mode} / {s.role_required}) — {s.fulfilled_at ? `fulfilled ${fmtDateDisplay(s.fulfilled_at)}` : "pending"}
                            {s.notes ? ` — ${s.notes}` : ""}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* Documents — only writable area in this modal */}
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Supporting documents</div>
            <div style={{ marginBottom: 16 }}>
              <DocumentAttachmentList
                contextTable="journal_entries"
                contextId={je.id}
                kinds={["supporting_doc", "approval_correspondence", "receipt", "other"]}
              />
            </div>

            {/* Cross-cutter T11-3 — audit trail timeline */}
            <RowHistory source_table="journal_entries" source_id={je.id} />
          </>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {canReverse && data && onReverseClick && (
            <button onClick={() => onReverseClick(data)} style={btnDanger}>Reverse</button>
          )}
          <button onClick={onClose} style={btnSecondary}>Close</button>
        </div>
      </div>
    </div>

    {/* QuickBooks-style: the actual invoice/bill, opened in place over the JE. */}
    {docOpen && <SourceDocumentModal doc={docOpen} onClose={() => setDocOpen(null)} />}
    </>
  );
}
