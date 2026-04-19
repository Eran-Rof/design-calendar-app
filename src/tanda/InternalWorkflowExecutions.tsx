import { useEffect, useState } from "react";

interface Execution {
  id: string;
  rule_id: string;
  rule: { id: string; name: string; trigger_event: string } | null;
  trigger_entity_type: string;
  trigger_entity_id: string | null;
  status: string;
  current_approver: string | null;
  triggered_at: string;
  metadata: { rule_name?: string; context?: Record<string, unknown>; approver_role?: string } | null;
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

export default function InternalWorkflowExecutions() {
  const [rows, setRows] = useState<Execution[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("pending");

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = filter === "all" ? "" : `?status=${filter}`;
      const r = await fetch(`/api/internal/workflow-executions${params}`);
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json() as { rows: Execution[] };
      setRows(d.rows || []);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [filter]);

  async function approve(id: string) {
    const reviewer = prompt("Your name (for audit):") || "Internal";
    const r = await fetch(`/api/internal/workflow-executions/${id}/approve`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewer }),
    });
    if (!r.ok) { alert(await r.text()); return; }
    await load();
  }
  async function reject(id: string) {
    const reason = prompt("Rejection reason:");
    if (!reason) return;
    const reviewer = prompt("Your name (for audit):") || "Internal";
    const r = await fetch(`/api/internal/workflow-executions/${id}/reject`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewer, rejection_reason: reason }),
    });
    if (!r.ok) { alert(await r.text()); return; }
    await load();
  }

  if (loading) return <div style={{ color: C.textMuted }}>Loading…</div>;
  if (err) return <div style={{ color: C.danger }}>Error: {err}</div>;

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Pending approvals</h2>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} style={selectSt}>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="auto_approved">Auto approved</option>
          <option value="all">All</option>
        </select>
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 130px 160px 1fr 140px 200px", padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
          <div>Rule</div>
          <div>Event</div>
          <div>Approver</div>
          <div>Context</div>
          <div>Triggered</div>
          <div style={{ textAlign: "right" }}>Action</div>
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13 }}>No executions match this filter.</div>
        ) : rows.map((e) => {
          const ctx = e.metadata?.context || {};
          const ctxSummary = summariseContext(ctx);
          return (
            <div key={e.id} style={{ display: "grid", gridTemplateColumns: "2fr 130px 160px 1fr 140px 200px", padding: "12px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center" }}>
              <div style={{ fontWeight: 600 }}>{e.rule?.name || "—"}</div>
              <div style={{ color: C.textSub, fontSize: 11, textTransform: "capitalize" }}>{(e.rule?.trigger_event || "").replace(/_/g, " ")}</div>
              <div style={{ color: C.textSub, fontSize: 11 }}>{e.current_approver || "—"}</div>
              <div style={{ color: C.textMuted, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ctxSummary}</div>
              <div style={{ color: C.textMuted, fontSize: 11 }}>{new Date(e.triggered_at).toLocaleString()}</div>
              <div style={{ textAlign: "right", display: "flex", gap: 6, justifyContent: "flex-end" }}>
                {e.status === "pending" ? (
                  <>
                    <button onClick={() => void reject(e.id)} style={{ ...btnSecondary, color: C.danger }}>Reject</button>
                    <button onClick={() => void approve(e.id)} style={{ ...btnPrimary, background: C.success }}>Approve</button>
                  </>
                ) : (
                  <span style={{ color: statusColor(e.status), fontSize: 11, fontWeight: 700, textTransform: "uppercase" }}>{e.status.replace(/_/g, " ")}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function summariseContext(ctx: Record<string, unknown>) {
  const parts: string[] = [];
  if (ctx.vendor_id) parts.push(`vendor ${String(ctx.vendor_id).slice(0, 8)}`);
  if (ctx.amount) parts.push(`amount $${Number(ctx.amount).toLocaleString()}`);
  if (ctx.anomaly_severity) parts.push(`severity ${ctx.anomaly_severity}`);
  if (ctx.po_number) parts.push(`PO ${ctx.po_number}`);
  if (ctx.invoice_number) parts.push(`Inv ${ctx.invoice_number}`);
  if (ctx.rfq_title) parts.push(`RFQ "${ctx.rfq_title}"`);
  return parts.join(" · ") || "—";
}

function statusColor(s: string) {
  if (s === "approved" || s === "auto_approved") return C.success;
  if (s === "rejected") return C.danger;
  return C.textSub;
}

const selectSt = { padding: "6px 10px", background: C.card, border: `1px solid ${C.cardBdr}`, color: C.text, borderRadius: 6, fontSize: 13 } as const;
const btnPrimary = { padding: "6px 14px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "6px 14px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" } as const;
