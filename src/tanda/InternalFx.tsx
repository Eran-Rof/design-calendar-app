import { useEffect, useState } from "react";

interface Rate {
  id: string;
  from_currency: string;
  to_currency: string;
  rate: number;
  source: string;
  snapshotted_at: string;
}
interface FxAnalytics {
  range: { from: string; to: string };
  totals: { fx_fee_amount: number; foreign_volume: number; international_payments_count: number };
  by_pair: { from: string; to: string; fee_total: number; volume: number; count: number }[];
  by_month: { month: string; fee_total: number; volume: number; count: number }[];
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

export default function InternalFx() {
  const [rates, setRates] = useState<Rate[]>([]);
  const [analytics, setAnalytics] = useState<FxAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const [rR, rA] = await Promise.all([
        fetch("/api/internal/fx/rates"),
        fetch("/api/internal/analytics/fx"),
      ]);
      if (!rR.ok) throw new Error(await rR.text());
      setRates(((await rR.json()) as { rows: Rate[] }).rows || []);
      if (rA.ok) setAnalytics(await rA.json() as FxAnalytics);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function syncNow() {
    if (!confirm("Fetch fresh FX rates now?")) return;
    const r = await fetch("/api/cron/fx-rate-sync", { method: "POST" });
    if (!r.ok && r.status !== 207) { alert(await r.text()); return; }
    const d = await r.json();
    alert(`Inserted ${d.inserted} rates. Errors: ${d.errors.length}`);
    await load();
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>FX rates</h2>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Synced every 4 hours from the configured provider (set via <code>FX_PROVIDER</code>).</div>
        </div>
        <button onClick={() => void syncNow()} style={btnPrimary}>Sync now</button>
      </div>

      {analytics && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 14 }}>
          <Stat label="Intl. payments (12mo)" value={String(analytics.totals.international_payments_count)} />
          <Stat label="Foreign volume" value={`$${Math.round(analytics.totals.foreign_volume).toLocaleString()}`} color={C.primary} />
          <Stat label="FX fees paid" value={`$${Math.round(analytics.totals.fx_fee_amount).toLocaleString()}`} color={C.warn} />
        </div>
      )}

      <h3 style={{ fontSize: 15, margin: "0 0 8px", color: C.textSub }}>Latest rates</h3>
      {loading ? <div style={{ color: C.textMuted }}>Loading…</div>
      : err ? <div style={{ color: C.danger }}>Error: {err}</div>
      : rates.length === 0 ? (
        <div style={{ padding: 20, textAlign: "center", color: C.textMuted, fontSize: 13, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>No rates yet. Click "Sync now" to fetch.</div>
      ) : (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", marginBottom: 18 }}>
          <div style={{ display: "grid", gridTemplateColumns: "120px 120px 160px 140px 1fr", padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
            <div>From</div><div>To</div><div>Rate</div><div>Source</div><div>Snapshot</div>
          </div>
          {rates.map((r) => (
            <div key={r.id} style={{ display: "grid", gridTemplateColumns: "120px 120px 160px 140px 1fr", padding: "10px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center" }}>
              <div style={{ fontWeight: 700 }}>{r.from_currency}</div>
              <div style={{ fontWeight: 700 }}>{r.to_currency}</div>
              <div>{Number(r.rate).toFixed(6)}</div>
              <div style={{ color: C.textMuted, fontSize: 11 }}>{r.source}</div>
              <div style={{ color: C.textMuted, fontSize: 11 }}>{new Date(r.snapshotted_at).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}

      {analytics && analytics.by_pair.length > 0 && (
        <>
          <h3 style={{ fontSize: 15, margin: "0 0 8px", color: C.textSub }}>Volume by pair (12mo)</h3>
          <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "120px 120px 120px 140px 100px", padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
              <div>From</div><div>To</div><div>Payments</div><div>Volume</div><div>Fees</div>
            </div>
            {analytics.by_pair.map((p, i) => (
              <div key={`${p.from}-${p.to}-${i}`} style={{ display: "grid", gridTemplateColumns: "120px 120px 120px 140px 100px", padding: "10px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center" }}>
                <div>{p.from}</div><div>{p.to}</div>
                <div style={{ color: C.textMuted }}>{p.count}</div>
                <div>${Math.round(p.volume).toLocaleString()}</div>
                <div style={{ color: C.warn }}>${Math.round(p.fee_total).toLocaleString()}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 12 }}>
      <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 700, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || C.text, marginTop: 4 }}>{value}</div>
    </div>
  );
}

const btnPrimary = { padding: "8px 14px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
