import { useEffect, useState } from "react";
import { supabaseVendor } from "./supabaseVendor";

interface Offer {
  id: string;
  invoice_id: string;
  original_due_date: string;
  early_payment_date: string;
  discount_pct: number;
  discount_amount: number;
  net_payment_amount: number;
  status: "offered" | "accepted" | "rejected" | "expired" | "paid";
  offered_at: string;
  expires_at: string;
  days_early?: number;
  annualized_return_pct?: number;
  invoice?: { id: string; invoice_number: string; total: number } | null;
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

async function token() {
  const { data: { session } } = await supabaseVendor.auth.getSession();
  return session?.access_token || "";
}
async function api(path: string, init: RequestInit = {}) {
  const t = await token();
  return fetch(path, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${t}` } });
}

export default function VendorDiscountOffers() {
  const [rows, setRows] = useState<Offer[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  async function load() {
    setLoading(true); setErr(null);
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      const r = await api(`/api/vendor/discount-offers?${params.toString()}`);
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json() as { rows: Offer[] };
      setRows(d.rows || []);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [status]);

  async function act(offer: Offer, action: "accept" | "reject") {
    if (action === "reject" && !confirm("Reject this offer? The invoice will be paid on its original due date.")) return;
    if (action === "accept" && !confirm(`Accept? You'll receive $${Number(offer.net_payment_amount).toFixed(2)} on ${offer.early_payment_date} (${offer.days_early} days early).`)) return;
    const r = await api(`/api/vendor/discount-offers/${offer.id}/${action}`, { method: "POST" });
    if (!r.ok) { alert(await r.text()); return; }
    await load();
  }

  const active = rows.filter((r) => r.status === "offered");
  const thisYearAccepted = rows.filter((r) => (r.status === "accepted" || r.status === "paid") && new Date(r.offered_at).getUTCFullYear() === new Date().getUTCFullYear());
  const ytdCaptured = thisYearAccepted.reduce((s, r) => s + Number(r.discount_amount || 0), 0);

  return (
    <div style={{ color: C.text, padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Early-payment offers</h2>
          <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>Get paid sooner in exchange for a discount. Accept or reject — rejecting means you're paid on the original due date.</div>
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={selectSt}>
          <option value="">All</option>
          <option value="offered">Active offers</option>
          <option value="accepted">Accepted</option>
          <option value="rejected">Rejected</option>
          <option value="expired">Expired</option>
          <option value="paid">Paid</option>
        </select>
      </div>

      {!loading && rows.length > 0 && (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 12, marginBottom: 14, display: "flex", gap: 14, alignItems: "baseline" }}>
          <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 700, textTransform: "uppercase" }}>YTD captured</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: C.success }}>${ytdCaptured.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div style={{ fontSize: 11, color: C.textMuted }}>{thisYearAccepted.length} offer{thisYearAccepted.length === 1 ? "" : "s"} accepted in {new Date().getUTCFullYear()}</div>
        </div>
      )}

      {loading ? <div style={{ color: C.textMuted }}>Loading…</div>
      : err ? <div style={{ color: C.danger }}>Error: {err}</div>
      : rows.length === 0 ? (
        <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>
          No offers at the moment.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {rows.map((o) => (
            <div key={o.id} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderLeft: `4px solid ${o.status === "offered" ? C.primary : o.status === "accepted" || o.status === "paid" ? C.success : C.textMuted}`, borderRadius: 8, padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>Invoice {o.invoice?.invoice_number || o.invoice_id.slice(0, 8)}</div>
                <StatusChip status={o.status} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginTop: 12 }}>
                <Mini label="You save"    value={`$${Number(o.discount_amount).toFixed(2)}`} color={C.success} />
                <Mini label="Paid on"     value={o.early_payment_date} />
                <Mini label="Days early"  value={String(o.days_early ?? "—")} color={C.primary} />
                <Mini label="You receive" value={`$${Number(o.net_payment_amount).toLocaleString()}`} />
              </div>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 10 }}>
                Original due: {o.original_due_date} · Discount {Number(o.discount_pct).toFixed(2)}% · Expires {new Date(o.expires_at).toLocaleDateString()}
              </div>
              {o.status === "offered" && (
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10 }}>
                  <button onClick={() => void act(o, "reject")} style={{ ...btnSecondary, color: C.danger }}>Reject</button>
                  <button onClick={() => void act(o, "accept")} style={{ ...btnPrimary, background: C.success }}>Accept</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {active.length === 0 && rows.length > 0 && (
        <div style={{ fontSize: 11, color: C.textMuted, textAlign: "center", marginTop: 14 }}>No active offers right now — we'll notify you when a new one arrives.</div>
      )}
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const color = status === "accepted" || status === "paid" ? C.success
    : status === "rejected" || status === "expired" ? C.danger
    : status === "offered" ? C.primary : C.textSub;
  return <span style={{ fontSize: 10, color: "#fff", background: color, padding: "2px 8px", borderRadius: 10, fontWeight: 700, textTransform: "uppercase" }}>{status}</span>;
}

function Mini({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ padding: 8, background: C.bg, border: `1px solid ${C.cardBdr}`, borderRadius: 6 }}>
      <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 700, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2, color: color || C.text }}>{value}</div>
    </div>
  );
}

const selectSt = { padding: "6px 10px", background: C.card, border: `1px solid ${C.cardBdr}`, color: C.text, borderRadius: 6, fontSize: 13 } as const;
const btnPrimary = { padding: "8px 14px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "8px 14px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" } as const;
