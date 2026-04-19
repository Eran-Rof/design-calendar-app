import { useEffect, useState } from "react";

interface Workflow {
  id: string;
  vendor_id: string;
  status: string;
  current_step: number;
  completed_steps: string[];
  started_at: string | null;
  completed_at: string | null;
  rejection_reason: string | null;
  vendor?: { id: string; name: string; status: string };
}

interface Detail {
  vendor: { id: string; name: string; status: string };
  workflow: Workflow | null;
  steps: { step_name: string; status: string; data: Record<string, unknown> | null; completed_at: string | null }[];
  banking: { id: string; bank_name: string; account_number_last4: string | null; account_type: string; currency: string; verified: boolean }[];
  compliance_document_types: { id: string; name: string; required: boolean }[];
  compliance_documents: { document_type_id: string; status: string; expiry_date: string | null }[];
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", danger: "#EF4444", success: "#10B981", warn: "#F59E0B",
};

export default function InternalOnboarding() {
  const [rows, setRows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("pending_review");
  const [selected, setSelected] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(filter === "all" ? "/api/internal/onboarding" : `/api/internal/onboarding?status=${filter}`);
      if (!r.ok) throw new Error(await r.text());
      setRows((await r.json()) as Workflow[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [filter]);

  if (loading) return <div style={{ color: C.textMuted }}>Loading…</div>;
  if (err) return <div style={{ color: C.danger }}>Error: {err}</div>;

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Onboarding review</h2>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ padding: "6px 10px", background: C.card, border: `1px solid ${C.cardBdr}`, color: C.text, borderRadius: 6 }}>
          <option value="pending_review">Pending review</option>
          <option value="in_progress">In progress</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="all">All</option>
        </select>
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.5fr 140px 140px 140px 140px", padding: "10px 14px", background: "#0F172A", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
          <div>Vendor</div>
          <div>Status</div>
          <div>Steps</div>
          <div>Submitted</div>
          <div></div>
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13 }}>No workflows in this view.</div>
        ) : rows.map((w) => (
          <div key={w.id} style={{ display: "grid", gridTemplateColumns: "1.5fr 140px 140px 140px 140px", padding: "12px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center" }}>
            <div style={{ fontWeight: 600 }}>{w.vendor?.name || "Unknown"}</div>
            <div style={{ color: statusColor(w.status), fontWeight: 600, textTransform: "capitalize" }}>{w.status.replace(/_/g, " ")}</div>
            <div style={{ color: C.textSub }}>{(w.completed_steps || []).length} / 6</div>
            <div style={{ color: C.textSub }}>{w.started_at ? new Date(w.started_at).toLocaleDateString() : "—"}</div>
            <div style={{ textAlign: "right" }}>
              <button onClick={() => setSelected(w.vendor_id)} style={btnPrimary}>Review →</button>
            </div>
          </div>
        ))}
      </div>

      {selected && <ReviewModal vendorId={selected} onClose={() => setSelected(null)} onAction={() => { setSelected(null); void load(); }} />}
    </div>
  );
}

function statusColor(s: string) {
  if (s === "approved") return C.success;
  if (s === "rejected") return C.danger;
  if (s === "pending_review") return C.warn;
  return C.textSub;
}

function ReviewModal({ vendorId, onClose, onAction }: { vendorId: string; onClose: () => void; onAction: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<"approve" | "reject" | null>(null);
  const [reviewer, setReviewer] = useState("");
  const [reason, setReason] = useState("");
  const [failedSteps, setFailedSteps] = useState<Set<string>>(new Set());

  useEffect(() => {
    (async () => {
      const r = await fetch(`/api/internal/onboarding/${vendorId}`);
      if (r.ok) setDetail((await r.json()) as Detail);
      setLoading(false);
    })();
  }, [vendorId]);

  async function submit() {
    if (!action) return;
    const body: Record<string, unknown> = { action, reviewer_name: reviewer || "Internal" };
    if (action === "reject") {
      if (!reason.trim()) { alert("Rejection reason required."); return; }
      body.rejection_reason = reason;
      body.failed_steps = [...failedSteps];
    }
    const r = await fetch(`/api/internal/onboarding/${vendorId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) { alert(await r.text()); return; }
    onAction();
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 22, width: 720, maxWidth: "92vw", maxHeight: "90vh", overflowY: "auto", color: C.text }}>
        {loading || !detail ? (
          <div style={{ color: C.textMuted }}>Loading…</div>
        ) : (
          <>
            <h3 style={{ margin: "0 0 14px", fontSize: 18 }}>{detail.vendor.name}</h3>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", fontWeight: 700 }}>Steps</div>
              {detail.steps.map((s) => (
                <div key={s.step_name} style={{ padding: "6px 0", borderBottom: `1px solid ${C.cardBdr}`, display: "grid", gridTemplateColumns: "160px 100px 1fr auto", gap: 10, fontSize: 12, alignItems: "center" }}>
                  <div style={{ fontWeight: 600 }}>{s.step_name.replace(/_/g, " ")}</div>
                  <div style={{ color: s.status === "complete" ? C.success : C.textMuted }}>{s.status}</div>
                  <div style={{ color: C.textSub, fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 11 }}>
                    {s.data ? JSON.stringify(s.data).slice(0, 80) : "—"}
                  </div>
                  {action === "reject" && (
                    <label style={{ fontSize: 11, color: C.danger, display: "flex", alignItems: "center", gap: 4 }}>
                      <input type="checkbox" checked={failedSteps.has(s.step_name)} onChange={(e) => {
                        const next = new Set(failedSteps);
                        if (e.target.checked) next.add(s.step_name); else next.delete(s.step_name);
                        setFailedSteps(next);
                      }} />
                      Reject
                    </label>
                  )}
                </div>
              ))}
            </div>

            {detail.banking.length > 0 && (
              <div style={{ marginBottom: 14, fontSize: 12, color: C.textSub }}>
                <b>Banking:</b> {detail.banking[0].bank_name} ••••{detail.banking[0].account_number_last4} ({detail.banking[0].account_type}, {detail.banking[0].currency}) — {detail.banking[0].verified ? "verified" : "unverified"}
              </div>
            )}

            {action === null ? (
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button onClick={() => setAction("reject")} style={{ ...btnSecondary, color: C.danger }}>Reject…</button>
                <button onClick={() => setAction("approve")} style={{ ...btnPrimary, background: C.success }}>Approve…</button>
                <button onClick={onClose} style={btnSecondary}>Close</button>
              </div>
            ) : (
              <div>
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", fontWeight: 700, marginBottom: 4 }}>Your name (for audit)</div>
                  <input value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="reviewer name" style={inp} />
                </div>
                {action === "reject" && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", fontWeight: 700, marginBottom: 4 }}>Rejection reason</div>
                    <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} style={{ ...inp, resize: "vertical" }} />
                    <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Use the checkboxes above to mark which steps need to be redone.</div>
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button onClick={() => setAction(null)} style={btnSecondary}>Back</button>
                  <button onClick={() => void submit()} style={action === "reject" ? { ...btnPrimary, background: C.danger } : { ...btnPrimary, background: C.success }}>
                    Confirm {action}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const inp = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: "#0F172A", color: C.text, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" } as const;
const btnPrimary = { padding: "6px 14px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "6px 14px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
