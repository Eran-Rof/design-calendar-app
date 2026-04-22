import { useEffect, useState } from "react";

interface Program {
  id: string;
  entity_id: string;
  name: string;
  funder_name: string;
  max_facility_amount: number;
  current_utilization: number;
  base_rate_pct: number;
  status: "active" | "paused" | "terminated";
}
interface Request {
  id: string;
  program_id: string;
  invoice_id: string;
  vendor_id: string;
  requested_amount: number;
  approved_amount: number | null;
  fee_pct: number | null;
  fee_amount: number | null;
  net_disbursement: number | null;
  status: "requested" | "approved" | "funded" | "repaid" | "rejected";
  rejection_reason: string | null;
  requested_at: string;
  repayment_due_date: string | null;
  program?: Program | null;
  vendor?: { id: string; name: string } | null;
  invoice?: { id: string; invoice_number: string; total: number; due_date: string } | null;
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

export default function InternalScf() {
  const [entities, setEntities] = useState<{ id: string; name: string }[]>([]);
  const [entityId, setEntityId] = useState("");
  const [programs, setPrograms] = useState<Program[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("requested");
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await fetch("/api/internal/entities?flat=true");
      if (r.ok) {
        const e = await r.json() as { id: string; name: string }[];
        setEntities(e);
        if (e.length && !entityId) setEntityId(e[0].id);
      }
    })();
  }, []);

  async function load() {
    if (!entityId) return;
    setLoading(true); setErr(null);
    try {
      const [rP, rR] = await Promise.all([
        fetch(`/api/internal/scf-programs?entity_id=${entityId}`),
        fetch(`/api/internal/scf/requests${statusFilter ? `?status=${statusFilter}` : ""}`),
      ]);
      if (!rP.ok) throw new Error(await rP.text());
      setPrograms(((await rP.json()) as { rows: Program[] }).rows || []);
      if (rR.ok) setRequests(((await rR.json()) as { rows: Request[] }).rows || []);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [entityId, statusFilter]);

  async function act(r: Request, action: "approve" | "fund") {
    if (action === "approve") {
      const approved = prompt("Approved amount:", String(r.requested_amount));
      if (!approved) return;
      const resp = await fetch(`/api/internal/scf/requests/${r.id}/approve`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved_amount: Number(approved) }),
      });
      if (!resp.ok) { alert(await resp.text()); return; }
    } else {
      if (!confirm("Confirm disbursement has been made?")) return;
      const resp = await fetch(`/api/internal/scf/requests/${r.id}/fund`, { method: "PUT" });
      if (!resp.ok) { alert(await resp.text()); return; }
    }
    await load();
  }

  async function toggleProgramStatus(p: Program) {
    const next = p.status === "active" ? "paused" : "active";
    const r = await fetch(`/api/internal/scf-programs/${p.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    if (!r.ok) { alert(await r.text()); return; }
    await load();
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Supply chain finance</h2>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Programs, utilization, and vendor finance requests.</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <select value={entityId} onChange={(e) => setEntityId(e.target.value)} style={selectSt}>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          <button onClick={() => setCreateOpen(true)} style={btnPrimary}>+ New program</button>
        </div>
      </div>

      <h3 style={{ fontSize: 15, margin: "12px 0 8px", color: C.textSub }}>Programs</h3>
      {programs.length === 0 ? (
        <div style={{ padding: 20, textAlign: "center", color: C.textMuted, fontSize: 13, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, marginBottom: 14 }}>No programs yet.</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 10, marginBottom: 18 }}>
          {programs.map((p) => {
            const utilPct = p.max_facility_amount > 0 ? (p.current_utilization / p.max_facility_amount) * 100 : 0;
            return (
              <div key={p.id} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <div style={{ fontWeight: 700 }}>{p.name}</div>
                  <button onClick={() => void toggleProgramStatus(p)} style={{ padding: "3px 10px", borderRadius: 12, border: "none", background: p.status === "active" ? C.success : C.textMuted, color: "#fff", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>{p.status}</button>
                </div>
                <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>Funder: {p.funder_name} · Base rate {Number(p.base_rate_pct).toFixed(2)}%</div>
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 11, color: C.textMuted }}>Utilization</div>
                  <div style={{ height: 6, background: C.bg, borderRadius: 3, overflow: "hidden", marginTop: 3 }}>
                    <div style={{ width: `${Math.min(100, utilPct).toFixed(0)}%`, height: "100%", background: utilPct > 80 ? C.danger : utilPct > 50 ? C.warn : C.success }} />
                  </div>
                  <div style={{ fontSize: 11, color: C.textSub, marginTop: 3 }}>
                    ${Math.round(p.current_utilization).toLocaleString()} / ${Math.round(p.max_facility_amount).toLocaleString()} ({utilPct.toFixed(0)}%)
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
        <h3 style={{ fontSize: 15, margin: 0, color: C.textSub }}>Requests</h3>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectSt}>
          <option value="requested">Pending approval</option>
          <option value="approved">Approved (needs funding)</option>
          <option value="funded">Funded</option>
          <option value="repaid">Repaid</option>
          <option value="rejected">Rejected</option>
          <option value="">All</option>
        </select>
      </div>

      {loading ? <div style={{ color: C.textMuted }}>Loading…</div>
      : err ? <div style={{ color: C.danger }}>Error: {err}</div>
      : requests.length === 0 ? (
        <div style={{ padding: 20, textAlign: "center", color: C.textMuted, fontSize: 13, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>No requests match.</div>
      ) : (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 120px 100px 100px 120px 150px", padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
            <div>Vendor / Invoice</div><div>Program</div><div>Requested</div><div>Fee</div><div>Net</div><div>Status</div><div style={{ textAlign: "right" }}>Action</div>
          </div>
          {requests.map((r) => (
            <div key={r.id} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 120px 100px 100px 120px 150px", padding: "10px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 600 }}>{r.vendor?.name || r.vendor_id}</div>
                <div style={{ fontSize: 11, color: C.textMuted }}>Inv {r.invoice?.invoice_number || r.invoice_id.slice(0, 8)} · due {r.invoice?.due_date || "—"}</div>
              </div>
              <div style={{ color: C.textSub, fontSize: 12 }}>{r.program?.name || r.program_id.slice(0, 8)}</div>
              <div>${Number(r.requested_amount).toLocaleString()}</div>
              <div style={{ color: C.textMuted }}>{r.fee_amount != null ? `$${Number(r.fee_amount).toFixed(2)}` : "—"}</div>
              <div>{r.net_disbursement != null ? `$${Number(r.net_disbursement).toLocaleString()}` : "—"}</div>
              <div><StatusChip status={r.status} /></div>
              <div style={{ textAlign: "right", display: "flex", gap: 4, justifyContent: "flex-end" }}>
                {r.status === "requested" && <button onClick={() => void act(r, "approve")} style={btnMini}>Approve</button>}
                {r.status === "approved"  && <button onClick={() => void act(r, "fund")}    style={{ ...btnMini, color: C.success }}>Fund</button>}
              </div>
            </div>
          ))}
        </div>
      )}

      {createOpen && entityId && <ProgramModal entityId={entityId} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); void load(); }} />}
    </div>
  );
}

function ProgramModal({ entityId, onClose, onCreated }: { entityId: string; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [funder, setFunder] = useState("");
  const [maxFacility, setMaxFacility] = useState("");
  const [baseRate, setBaseRate] = useState("6");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim() || !funder.trim() || !maxFacility) { alert("Name, funder, and facility amount required"); return; }
    setSaving(true);
    try {
      const r = await fetch("/api/internal/scf-programs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity_id: entityId, name: name.trim(), funder_name: funder.trim(), max_facility_amount: Number(maxFacility), base_rate_pct: Number(baseRate) }),
      });
      if (!r.ok) throw new Error(await r.text());
      onCreated();
    } catch (e: unknown) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modal, width: 480 }}>
        <h3 style={{ margin: "0 0 14px", fontSize: 18 }}>New SCF program</h3>
        <Row label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Q3 Supplier Financing" style={inp} /></Row>
        <Row label="Funder"><input value={funder} onChange={(e) => setFunder(e.target.value)} placeholder="JP Morgan, etc." style={inp} /></Row>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
          <Row label="Max facility ($)"><input type="number" value={maxFacility} onChange={(e) => setMaxFacility(e.target.value)} style={inp} /></Row>
          <Row label="Base rate % (APR)"><input type="number" step="0.01" value={baseRate} onChange={(e) => setBaseRate(e.target.value)} style={inp} /></Row>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={() => void save()} disabled={saving} style={btnPrimary}>{saving ? "Creating…" : "Create"}</button>
        </div>
      </div>
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const color = status === "funded" || status === "repaid" ? C.success
    : status === "rejected" ? C.danger
    : status === "approved" ? C.warn
    : status === "requested" ? C.primary : C.textSub;
  return <span style={{ fontSize: 10, color: "#fff", background: color, padding: "2px 8px", borderRadius: 10, fontWeight: 700, textTransform: "uppercase" }}>{status}</span>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const inp = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.bg, color: C.text, fontSize: 13, boxSizing: "border-box" } as const;
const selectSt = { padding: "6px 10px", background: C.card, border: `1px solid ${C.cardBdr}`, color: C.text, borderRadius: 6, fontSize: 13 } as const;
const btnPrimary = { padding: "8px 14px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "6px 12px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" } as const;
const btnMini = { padding: "3px 10px", borderRadius: 4, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 11, fontWeight: 600, fontFamily: "inherit" } as const;
const overlay = { position: "fixed" as const, inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 };
const modal = { background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 22, maxWidth: "92vw", maxHeight: "90vh", overflowY: "auto" as const, color: C.text };
