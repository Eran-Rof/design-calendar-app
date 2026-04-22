import { useEffect, useState } from "react";

interface Offer {
  id: string;
  entity_id: string;
  invoice_id: string;
  vendor_id: string;
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
  vendor?: { id: string; name: string } | null;
  invoice?: { id: string; invoice_number: string; total: number } | null;
}
interface Analytics {
  total_offers_made: number;
  total_offers_accepted: number;
  total_discount_captured: number;
  total_early_payment_amount: number;
  avg_discount_pct: number;
  annualized_return_pct: number;
  acceptance_rate_pct: number;
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

export default function InternalDiscountOffers() {
  const [entities, setEntities] = useState<{ id: string; name: string }[]>([]);
  const [entityId, setEntityId] = useState("");
  const [offers, setOffers] = useState<Offer[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState("");

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
      const params = new URLSearchParams({ entity_id: entityId });
      if (status) params.set("status", status);
      const [rO, rA] = await Promise.all([
        fetch(`/api/internal/discount-offers?${params.toString()}`),
        fetch(`/api/internal/discount-offers/analytics?entity_id=${entityId}`),
      ]);
      if (!rO.ok) throw new Error(await rO.text());
      const d = await rO.json() as { rows: Offer[] };
      setOffers(d.rows || []);
      if (rA.ok) setAnalytics(await rA.json() as Analytics);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [entityId, status]);

  async function runJob() {
    if (!confirm("Run the discount offer generator now for this entity?")) return;
    const r = await fetch("/api/internal/discount-offers/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entity_id: entityId }),
    });
    if (!r.ok) { alert(await r.text()); return; }
    const d = await r.json() as { created: Offer[]; skipped: { invoice_id: string; reason: string }[] };
    alert(`Created ${d.created.length} offers. Skipped ${d.skipped.length}.`);
    await load();
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Dynamic discounts</h2>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Offer vendors early payment in exchange for a discount. Generated daily at 11:00 UTC.</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <select value={entityId} onChange={(e) => setEntityId(e.target.value)} style={selectSt}>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={selectSt}>
            <option value="">All statuses</option>
            <option value="offered">Offered</option>
            <option value="accepted">Accepted</option>
            <option value="rejected">Rejected</option>
            <option value="expired">Expired</option>
            <option value="paid">Paid</option>
          </select>
          <button onClick={() => void runJob()} style={btnPrimary}>Generate now</button>
        </div>
      </div>

      {analytics && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 14 }}>
          <Stat label="Offers made (YTD)" value={String(analytics.total_offers_made)} />
          <Stat label="Acceptance rate" value={`${analytics.acceptance_rate_pct.toFixed(0)}%`} color={C.primary} />
          <Stat label="Discount captured" value={`$${Math.round(analytics.total_discount_captured).toLocaleString()}`} color={C.success} />
          <Stat label="Annualized return" value={`${analytics.annualized_return_pct.toFixed(1)}%`} color={C.warn} />
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 14 }}>
        {(["offered", "accepted", "rejected", "expired"] as const).map((s) => {
          const n = offers.filter((o) => o.status === s).length;
          const color = s === "accepted" ? C.success : s === "rejected" || s === "expired" ? C.danger : C.primary;
          return <Stat key={s} label={s} value={String(n)} color={color} />;
        })}
      </div>

      {loading ? <div style={{ color: C.textMuted }}>Loading…</div>
      : err ? <div style={{ color: C.danger }}>Error: {err}</div>
      : offers.length === 0 ? (
        <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>No offers match.</div>
      ) : (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 100px 120px 100px 100px 100px 110px", padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
            <div>Vendor / Invoice</div><div>Early pay</div><div>Days early</div><div>Discount</div><div>Net</div><div>APR</div><div>Status</div><div>Expires</div>
          </div>
          {offers.map((o) => (
            <div key={o.id} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 100px 120px 100px 100px 100px 110px", padding: "10px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 600 }}>{o.vendor?.name || o.vendor_id}</div>
                <div style={{ fontSize: 11, color: C.textMuted }}>Inv {o.invoice?.invoice_number || o.invoice_id.slice(0, 8)}</div>
              </div>
              <div style={{ color: C.textSub, fontSize: 12 }}>{o.early_payment_date}</div>
              <div style={{ color: C.textMuted }}>{o.days_early ?? "—"}</div>
              <div><strong>${Number(o.discount_amount).toFixed(2)}</strong> <span style={{ color: C.textMuted, fontSize: 11 }}>({Number(o.discount_pct).toFixed(2)}%)</span></div>
              <div>${Number(o.net_payment_amount).toLocaleString()}</div>
              <div style={{ color: C.warn, fontWeight: 600 }}>{o.annualized_return_pct != null ? `${o.annualized_return_pct.toFixed(1)}%` : "—"}</div>
              <div><StatusChip status={o.status} /></div>
              <div style={{ color: C.textMuted, fontSize: 11 }}>{new Date(o.expires_at).toLocaleDateString()}</div>
            </div>
          ))}
        </div>
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

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 12 }}>
      <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 700, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || C.text, marginTop: 4 }}>{value}</div>
    </div>
  );
}

const selectSt = { padding: "6px 10px", background: C.card, border: `1px solid ${C.cardBdr}`, color: C.text, borderRadius: 6, fontSize: 13 } as const;
const btnPrimary = { padding: "8px 14px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
