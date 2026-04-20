import { useEffect, useState } from "react";
import { supabaseVendor } from "./supabaseVendor";

interface Eligible {
  invoice: { id: string; invoice_number: string; total: number; due_date: string; currency: string };
  program_id: string;
  program_name: string;
  days_to_due: number;
  est_fee_pct: number;
  est_fee_amount: number;
  est_net_disbursement: number;
}
interface Req {
  id: string;
  requested_amount: number;
  approved_amount: number | null;
  fee_amount: number | null;
  net_disbursement: number | null;
  status: "requested" | "approved" | "funded" | "repaid" | "rejected";
  requested_at: string;
  repayment_due_date: string | null;
  program?: { id: string; name: string; funder_name: string } | null;
  invoice?: { id: string; invoice_number: string; total: number; due_date: string } | null;
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

async function token() { const { data: { session } } = await supabaseVendor.auth.getSession(); return session?.access_token || ""; }
async function api(path: string, init: RequestInit = {}) { const t = await token(); return fetch(path, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${t}` } }); }

export default function VendorScf() {
  const [eligible, setEligible] = useState<Eligible[]>([]);
  const [requests, setRequests] = useState<Req[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const [rE, rR] = await Promise.all([api("/api/vendor/scf/eligible-invoices"), api("/api/vendor/scf/requests")]);
      if (!rE.ok) throw new Error(await rE.text());
      setEligible(((await rE.json()) as { rows: Eligible[] }).rows || []);
      if (rR.ok) setRequests(((await rR.json()) as { rows: Req[] }).rows || []);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function request(row: Eligible) {
    if (!confirm(`Request financing on invoice ${row.invoice.invoice_number}? You'll receive ~$${row.est_net_disbursement.toLocaleString()} after a $${row.est_fee_amount.toLocaleString()} fee.`)) return;
    const r = await api("/api/vendor/scf/request", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invoice_id: row.invoice.id, program_id: row.program_id }),
    });
    if (!r.ok) { alert(await r.text()); return; }
    await load();
  }

  return (
    <div style={{ color: C.text, padding: 20 }}>
      <h2 style={{ margin: 0, fontSize: 22 }}>Supply chain finance</h2>
      <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4, marginBottom: 16 }}>Get paid early on approved invoices. Fees are prorated from the program's annual base rate.</div>

      {err && <div style={{ color: C.danger, marginBottom: 10 }}>{err}</div>}

      <h3 style={{ fontSize: 15, margin: "12px 0 8px", color: C.textSub }}>Eligible invoices</h3>
      {loading ? <div style={{ color: C.textMuted }}>Loading…</div>
      : eligible.length === 0 ? (
        <div style={{ padding: 20, textAlign: "center", color: C.textMuted, fontSize: 13, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>No eligible invoices right now.</div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {eligible.map((row) => (
            <div key={row.invoice.id} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div style={{ fontWeight: 700 }}>Invoice {row.invoice.invoice_number}</div>
                <div style={{ fontSize: 11, color: C.textMuted }}>Program: {row.program_name} · Due {row.invoice.due_date} ({row.days_to_due}d)</div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginTop: 10 }}>
                <Mini label="Invoice amount" value={`$${Number(row.invoice.total).toLocaleString()}`} />
                <Mini label="Fee" value={`$${row.est_fee_amount.toLocaleString()}`} color={C.warn} />
                <Mini label="Fee %" value={`${row.est_fee_pct.toFixed(3)}%`} color={C.textSub} />
                <Mini label="You receive" value={`$${row.est_net_disbursement.toLocaleString()}`} color={C.success} />
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                <button onClick={() => void request(row)} style={btnPrimary}>Request financing</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <h3 style={{ fontSize: 15, margin: "20px 0 8px", color: C.textSub }}>Your requests ({requests.length})</h3>
      {requests.length === 0 ? (
        <div style={{ padding: 20, textAlign: "center", color: C.textMuted, fontSize: 13, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>No requests yet.</div>
      ) : (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 110px 110px 110px 100px 110px", padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
            <div>Invoice</div><div>Program</div><div>Requested</div><div>Fee</div><div>Net</div><div>Status</div><div>Repay by</div>
          </div>
          {requests.map((r) => (
            <div key={r.id} style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 110px 110px 110px 100px 110px", padding: "10px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 600 }}>{r.invoice?.invoice_number || "—"}</div>
                <div style={{ fontSize: 11, color: C.textMuted }}>{new Date(r.requested_at).toLocaleDateString()}</div>
              </div>
              <div style={{ color: C.textSub, fontSize: 12 }}>{r.program?.name || "—"}</div>
              <div>${Number(r.requested_amount).toLocaleString()}</div>
              <div style={{ color: C.textMuted }}>{r.fee_amount != null ? `$${Number(r.fee_amount).toFixed(2)}` : "—"}</div>
              <div>{r.net_disbursement != null ? `$${Number(r.net_disbursement).toLocaleString()}` : "—"}</div>
              <div><StatusChip status={r.status} /></div>
              <div style={{ color: C.textMuted, fontSize: 11 }}>{r.repayment_due_date || "—"}</div>
            </div>
          ))}
        </div>
      )}
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

function Mini({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ padding: 8, background: C.bg, border: `1px solid ${C.cardBdr}`, borderRadius: 6 }}>
      <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 700, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, marginTop: 2, color: color || C.text }}>{value}</div>
    </div>
  );
}

const btnPrimary = { padding: "8px 14px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
