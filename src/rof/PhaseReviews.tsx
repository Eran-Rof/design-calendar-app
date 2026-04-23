import { useEffect, useMemo, useState } from "react";

type PriorReview = {
  id: string;
  status: "approved" | "rejected";
  new_value: string | null;
  old_value: string | null;
  reviewed_at: string;
  review_note: string | null;
  reviewed_by_internal_id: string | null;
};

type Req = {
  id: string;
  vendor_id: string;
  vendor_name: string;
  po_id: string;
  po_number: string;
  phase_name: string;
  field_name: string;
  old_value: string | null;
  new_value: string | null;
  status: "pending" | "approved" | "rejected";
  requested_at: string;
  reviewed_at: string | null;
  reviewed_by_internal_id: string | null;
  review_note: string | null;
  po_line_key: string | null;
  requested_by_display_name: string | null;
  scope?: "master" | "line";
  line_label?: string | null;
  line_description?: string | null;
  prior_reviews_count?: number;
  last_rejected_at?: string | null;
  last_rejected_note?: string | null;
  prior_reviews?: PriorReview[];
};

type Note = {
  id: string;
  vendor_id: string;
  po_id: string;
  phase_name: string;
  po_line_key: string | null;
  body: string;
  author_name: string | null;
  created_at: string;
  updated_at: string;
};

// Dark theme matching the PO WIP (TandA) app.
const C = {
  bg: "#0F172A",          // slate-900
  surface: "#1E293B",     // slate-800
  surfaceHi: "#334155",   // slate-700
  border: "#334155",
  borderLt: "#475569",
  text: "#F1F5F9",
  textSub: "#CBD5E1",
  textMuted: "#94A3B8",
  primary: "#3B82F6",
  success: "#10B981",
  danger: "#EF4444",
  warn: "#F59E0B",
  accent: "#7C3AED",
};

function statusColor(s: Req["status"]) {
  if (s === "approved") return C.success;
  if (s === "rejected") return C.danger;
  return C.warn;
}

function loadReviewer(): string {
  try {
    const raw = sessionStorage.getItem("plm_session_v2");
    if (raw) {
      const u = JSON.parse(raw);
      return u?.name || u?.username || "Ring of Fire";
    }
  } catch { /* noop */ }
  return "Ring of Fire";
}

type ActionDialogState = {
  kind: "approve" | "reject" | "flip";
  req: Req;
  targetStatus?: "approved" | "rejected"; // only when kind === "flip"
};

function ActionDialog({
  state, reviewer, onSubmit, onCancel,
}: {
  state: ActionDialogState;
  reviewer: string;
  onSubmit: (note: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const effective = state.kind === "flip" ? state.targetStatus! : state.kind === "approve" ? "approved" : "rejected";
  const isReject = effective === "rejected";
  const headline = state.kind === "flip"
    ? `Change decision → ${effective}`
    : isReject ? "Reject change" : "Approve change";

  async function handleSubmit() {
    if (isReject && !note.trim()) return;
    setBusy(true);
    try { await onSubmit(note.trim()); }
    finally { setBusy(false); }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={(e) => { if (e.currentTarget === e.target && !busy) onCancel(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.7)",
      }}
    >
      <div style={{
        width: "min(520px, calc(100vw - 32px))",
        background: C.surface,
        border: `1px solid ${isReject ? C.danger : C.success}44`,
        borderRadius: 14,
        boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
        overflow: "hidden",
        color: C.text,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}>
        <div style={{
          padding: "20px 24px",
          borderBottom: `1px solid ${C.border}`,
          background: `linear-gradient(135deg, ${isReject ? C.danger : C.success}22, ${isReject ? C.warn : C.primary}22)`,
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, color: isReject ? "#FCA5A5" : "#6EE7B7", marginBottom: 6 }}>
            {headline}
          </div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>
            {state.req.po_number} · {state.req.phase_name}
          </div>
          <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>
            {state.req.field_name}: <span style={{ color: C.textSub }}>{state.req.old_value ?? "(empty)"}</span>
            <span style={{ margin: "0 6px" }}>→</span>
            <span style={{ color: isReject ? "#FCA5A5" : "#6EE7B7" }}>{state.req.new_value ?? "(cleared)"}</span>
          </div>
        </div>

        <div style={{ padding: "16px 24px" }}>
          <label style={{ display: "block", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: C.textMuted, marginBottom: 6 }}>
            {isReject ? "Reason (required)" : "Note (optional)"}
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={4}
            autoFocus
            placeholder={isReject
              ? "Explain why — the vendor will see this in the PO message thread."
              : "Add context for the vendor, or leave blank."}
            style={{
              width: "100%", boxSizing: "border-box",
              background: C.bg, color: C.text,
              border: `1px solid ${C.borderLt}`, borderRadius: 8,
              padding: "10px 12px", fontSize: 13, fontFamily: "inherit",
              resize: "vertical",
            }}
          />
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>
            Posted as <strong style={{ color: C.textSub }}>{reviewer}</strong>.
          </div>
        </div>

        <div style={{
          padding: "12px 24px", borderTop: `1px solid ${C.border}`,
          display: "flex", justifyContent: "flex-end", gap: 8, background: C.bg,
        }}>
          <button onClick={onCancel} disabled={busy} style={{
            padding: "8px 16px", borderRadius: 8, border: `1px solid ${C.borderLt}`,
            background: "transparent", color: C.textSub,
            cursor: busy ? "not-allowed" : "pointer",
            fontSize: 13, fontWeight: 600, fontFamily: "inherit",
          }}>Cancel</button>
          <button
            onClick={() => void handleSubmit()}
            disabled={busy || (isReject && !note.trim())}
            style={{
              padding: "8px 20px", borderRadius: 8, border: "none",
              background: busy ? C.surfaceHi : (isReject ? C.danger : C.success),
              color: "#fff",
              cursor: busy || (isReject && !note.trim()) ? "not-allowed" : "pointer",
              opacity: (isReject && !note.trim()) ? 0.6 : 1,
              fontSize: 13, fontWeight: 700, fontFamily: "inherit",
            }}
          >{busy ? "Sending…" : isReject ? "Reject" : "Approve"}</button>
        </div>
      </div>
    </div>
  );
}

function Toast({ text, tone, onClose }: { text: string; tone: "success" | "danger"; onClose: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, 3200); return () => clearTimeout(t); }, [onClose]);
  return (
    <div style={{
      position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
      background: tone === "success" ? C.success : C.danger,
      color: "#fff", padding: "10px 20px", borderRadius: 8,
      boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
      fontSize: 13, fontWeight: 600, zIndex: 10000,
    }}>{text}</div>
  );
}

export default function PhaseReviews() {
  const [rows, setRows] = useState<Req[]>([]);
  const [notesByPoPhase, setNotesByPoPhase] = useState<Record<string, Note[]>>({});
  const [statusFilter, setStatusFilter] = useState<"pending" | "all" | "approved" | "rejected">("pending");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ActionDialogState | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: "success" | "danger" } | null>(null);
  const reviewer = useMemo(() => loadReviewer(), []);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/phase-change-requests?status=${statusFilter}&limit=200`);
      if (!r.ok) throw new Error(await r.text());
      const body = (await r.json()) as { rows: Req[] };
      setRows(body.rows || []);

      const poIds = Array.from(new Set((body.rows || []).map((x) => x.po_id)));
      const notes: Record<string, Note[]> = {};
      await Promise.all(poIds.map(async (poId) => {
        const nr = await fetch(`/api/internal/phase-notes?po_id=${poId}`);
        if (!nr.ok) return;
        const nbody = (await nr.json()) as { rows: Note[] };
        for (const n of nbody.rows || []) {
          const key = `${n.po_id}::${n.phase_name}`;
          if (!notes[key]) notes[key] = [];
          notes[key].push(n);
        }
      }));
      setNotesByPoPhase(notes);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [statusFilter]);

  async function submitAction(note: string) {
    if (!dialog) return;
    const kind = dialog.kind;
    const id = dialog.req.id;
    const { url, successLabel } = kind === "flip"
      ? { url: `/api/internal/phase-change-requests/${id}/set-status`, successLabel: `Marked ${dialog.targetStatus}` }
      : { url: `/api/internal/phase-change-requests/${id}/${kind}`, successLabel: kind === "approve" ? "Approved" : "Rejected" };
    const body = kind === "flip"
      ? { status: dialog.targetStatus, reviewer_name: reviewer, note }
      : { reviewer_name: reviewer, note };
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text();
      setToast({ text: `Failed: ${t.slice(0, 120)}`, tone: "danger" });
      return;
    }
    setDialog(null);
    setToast({ text: successLabel, tone: "success" });
    await load();
  }

  async function revertToPending(req: Req) {
    const r = await fetch(`/api/internal/phase-change-requests/${req.id}/set-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "pending", reviewer_name: reviewer }),
    });
    if (!r.ok) {
      const t = await r.text();
      setToast({ text: `Failed: ${t.slice(0, 120)}`, tone: "danger" });
      return;
    }
    setToast({ text: "Moved back to pending", tone: "success" });
    await load();
  }

  const counts = useMemo(() => {
    const out = { pending: 0, approved: 0, rejected: 0 };
    for (const r of rows) out[r.status] += 1;
    return out;
  }, [rows]);

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, padding: 24, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      <div style={{ maxWidth: 1400, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, gap: 16, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: C.text }}>Vendor phase reviews</h1>
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>
              Reviewer: <strong style={{ color: C.textSub }}>{reviewer}</strong> · Approvals and rejections auto-post to the PO message thread.
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {(["pending", "approved", "rejected", "all"] as const).map((f) => (
              <button key={f} onClick={() => setStatusFilter(f)}
                style={{
                  padding: "6px 14px", borderRadius: 6,
                  border: `1px solid ${statusFilter === f ? C.primary : C.borderLt}`,
                  background: statusFilter === f ? C.primary : C.surface,
                  color: statusFilter === f ? "#fff" : C.textSub,
                  cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600,
                  textTransform: "capitalize",
                }}>{f}</button>
            ))}
            <button onClick={() => void load()} title="Refresh" style={{
              padding: "6px 12px", borderRadius: 6, border: `1px solid ${C.borderLt}`,
              background: C.surface, color: C.textSub, cursor: "pointer", fontFamily: "inherit", fontSize: 12,
            }}>↻</button>
          </div>
        </div>

        {err && <div style={{ background: "#7F1D1D44", color: "#FCA5A5", border: `1px solid ${C.danger}`, padding: 12, borderRadius: 8, marginBottom: 14, fontSize: 13 }}>{err}</div>}

        {loading ? (
          <div style={{ color: C.textMuted, padding: 40, textAlign: "center" }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, padding: 40, borderRadius: 10, textAlign: "center", color: C.textMuted }}>
            No {statusFilter === "all" ? "" : statusFilter} requests.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {rows.map((r) => {
              const notes = notesByPoPhase[`${r.po_id}::${r.phase_name}`] || [];
              const isResubmission = r.status === "pending" && (r.prior_reviews_count ?? 0) > 0;
              return (
                <div key={r.id} style={{ background: C.surface, border: `1px solid ${isResubmission ? C.warn : C.border}`, borderRadius: 10, padding: 16 }}>
                  {isResubmission && (
                    <div style={{ marginBottom: 12, padding: "8px 12px", background: `${C.warn}22`, border: `1px solid ${C.warn}66`, borderRadius: 6, fontSize: 12, color: "#FCD34D", display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 14 }}>⚠️</span>
                      <div>
                        <strong>Resubmission</strong> — this phase was reviewed {r.prior_reviews_count} time{r.prior_reviews_count === 1 ? "" : "s"} before.
                        {r.last_rejected_at && (
                          <>
                            {" Previously rejected on "}
                            <strong>{new Date(r.last_rejected_at).toLocaleDateString()}</strong>
                            {r.last_rejected_note && <>: <span style={{ fontStyle: "italic", color: C.textSub }}>"{r.last_rejected_note}"</span></>}
                          </>
                        )}
                      </div>
                    </div>
                  )}

                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                        <span style={{ background: C.bg, padding: "2px 10px", borderRadius: 4, fontFamily: "Menlo, monospace", fontSize: 12, fontWeight: 700, color: C.primary, border: `1px solid ${C.border}` }}>{r.po_number}</span>
                        <span style={{ fontSize: 12, color: C.textMuted }}>·</span>
                        <span style={{ fontWeight: 600, fontSize: 14, color: C.text }}>{r.phase_name}</span>
                        {r.scope === "line" ? (
                          <span
                            title={r.line_description || "Line-item level change"}
                            style={{ fontSize: 10, background: C.accent, color: "#EDE9FE", padding: "2px 10px", borderRadius: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, display: "inline-flex", alignItems: "center", gap: 4 }}
                          >
                            <span>🔀</span>
                            <span>Line {r.line_label ? `· ${r.line_label}` : ""}</span>
                          </span>
                        ) : (
                          <span style={{ fontSize: 10, background: C.surfaceHi, color: C.textSub, padding: "2px 10px", borderRadius: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>Master</span>
                        )}
                        <span style={{ fontSize: 10, color: "#fff", background: statusColor(r.status), padding: "2px 10px", borderRadius: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>{r.status}</span>
                      </div>
                      <div style={{ fontSize: 12, color: C.textMuted }}>
                        <strong style={{ color: C.textSub }}>{r.vendor_name}</strong>
                        {r.requested_by_display_name && ` · ${r.requested_by_display_name}`}
                        {" · requested "}{new Date(r.requested_at).toLocaleString()}
                      </div>
                    </div>
                    {r.status === "pending" ? (
                      <div style={{ display: "flex", gap: 6 }}>
                        <button onClick={() => setDialog({ kind: "approve", req: r })} style={{ padding: "8px 18px", borderRadius: 8, border: "none", background: C.success, color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 700, fontFamily: "inherit" }}>Approve</button>
                        <button onClick={() => setDialog({ kind: "reject", req: r })} style={{ padding: "8px 18px", borderRadius: 8, border: "none", background: C.danger, color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 700, fontFamily: "inherit" }}>Reject</button>
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                        <button
                          onClick={() => void revertToPending(r)}
                          title="Reopen this request so it goes back to the pending queue"
                          style={{ padding: "6px 12px", borderRadius: 6, border: `1px solid ${C.borderLt}`, background: "transparent", color: C.textSub, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}
                        >↺ Revert to pending</button>
                        {r.status === "approved" ? (
                          <button
                            onClick={() => setDialog({ kind: "flip", req: r, targetStatus: "rejected" })}
                            style={{ padding: "6px 12px", borderRadius: 6, border: `1px solid ${C.danger}`, background: "transparent", color: C.danger, cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: "inherit" }}
                          >✗ Change to rejected</button>
                        ) : (
                          <button
                            onClick={() => setDialog({ kind: "flip", req: r, targetStatus: "approved" })}
                            style={{ padding: "6px 12px", borderRadius: 6, border: `1px solid ${C.success}`, background: "transparent", color: C.success, cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: "inherit" }}
                          >✓ Change to approved</button>
                        )}
                      </div>
                    )}
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "140px 1fr 1fr", gap: 10, marginTop: 12, alignItems: "start" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: C.textMuted, letterSpacing: 0.4, paddingTop: 6 }}>{r.field_name}</div>
                    <div style={{ background: C.bg, padding: 10, borderRadius: 8, fontSize: 13, border: `1px solid ${C.border}` }}>
                      <div style={{ fontSize: 10, textTransform: "uppercase", color: C.textMuted, fontWeight: 700, letterSpacing: 0.4 }}>From</div>
                      <div style={{ color: C.textSub, marginTop: 3 }}>{r.old_value ?? <span style={{ color: C.textMuted, fontStyle: "italic" }}>(empty)</span>}</div>
                    </div>
                    <div style={{ background: "#064E3B33", padding: 10, borderRadius: 8, fontSize: 13, border: `1px solid ${C.success}55` }}>
                      <div style={{ fontSize: 10, textTransform: "uppercase", color: C.textMuted, fontWeight: 700, letterSpacing: 0.4 }}>To</div>
                      <div style={{ color: "#6EE7B7", marginTop: 3 }}>{r.new_value ?? <span style={{ color: C.textMuted, fontStyle: "italic" }}>(cleared)</span>}</div>
                    </div>
                  </div>

                  {notes.length > 0 && (
                    <div style={{ marginTop: 12, padding: 10, background: C.bg, border: `1px solid ${C.warn}55`, borderRadius: 8 }}>
                      <div style={{ fontSize: 10, textTransform: "uppercase", color: C.warn, fontWeight: 700, letterSpacing: 0.4, marginBottom: 8 }}>
                        💬 Vendor notes on this phase ({notes.length})
                      </div>
                      <div style={{ display: "grid", gap: 6 }}>
                        {notes.slice(0, 5).map((n) => (
                          <div key={n.id} style={{ fontSize: 12, padding: 8, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6 }}>
                            <div style={{ color: C.textMuted, fontSize: 11 }}>
                              {n.author_name || "Vendor"} · {new Date(n.created_at).toLocaleString()}
                            </div>
                            <div style={{ marginTop: 3, whiteSpace: "pre-wrap", color: C.textSub }}>{n.body}</div>
                          </div>
                        ))}
                        {notes.length > 5 && <div style={{ fontSize: 11, color: C.textMuted }}>+ {notes.length - 5} more</div>}
                      </div>
                    </div>
                  )}

                  {r.status !== "pending" && r.review_note && (
                    <div style={{ marginTop: 12, padding: 10, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, color: C.textSub }}>
                      <strong style={{ color: C.text }}>{r.reviewed_by_internal_id || "Reviewer"}:</strong> {r.review_note}
                      {r.reviewed_at && <span style={{ color: C.textMuted }}> · {new Date(r.reviewed_at).toLocaleString()}</span>}
                    </div>
                  )}

                  {(r.prior_reviews?.length ?? 0) > 0 && (
                    <div style={{ marginTop: 10, padding: 8, background: C.bg, border: `1px dashed ${C.border}`, borderRadius: 6, fontSize: 11, color: C.textMuted }}>
                      <div style={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>Prior review history</div>
                      {(r.prior_reviews || []).map((p) => (
                        <div key={p.id} style={{ marginTop: 2 }}>
                          {p.status === "approved" ? "✓" : "✗"} {p.status} {p.new_value ?? "(cleared)"} on {new Date(p.reviewed_at).toLocaleDateString()}
                          {p.reviewed_by_internal_id && ` by ${p.reviewed_by_internal_id}`}
                          {p.review_note && <span style={{ fontStyle: "italic" }}> — "{p.review_note}"</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div style={{ marginTop: 20, fontSize: 11, color: C.textMuted, textAlign: "center" }}>
          {counts.pending} pending · {counts.approved} approved · {counts.rejected} rejected (in current filter)
        </div>
      </div>

      {dialog && (
        <ActionDialog
          state={dialog}
          reviewer={reviewer}
          onSubmit={submitAction}
          onCancel={() => setDialog(null)}
        />
      )}
      {toast && <Toast text={toast.text} tone={toast.tone} onClose={() => setToast(null)} />}
    </div>
  );
}
