import { useEffect, useState } from "react";
import { supabaseVendor } from "./supabaseVendor";

interface Row {
  invoice_id: string;
  invoice_number: string;
  invoice_date: string;
  currency: string;
  status: string;
  due_date: string;
  gross_amount: number;
  withholding_amount: number;
  net_payment_amount: number;
  calculations: { jurisdiction: string; rate_pct: number; amount: number }[];
}
interface Totals { gross: number; withholding: number; net: number }

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

async function token() { const { data: { session } } = await supabaseVendor.auth.getSession(); return session?.access_token || ""; }

export default function VendorWithholding() {
  const [rows, setRows] = useState<Row[]>([]);
  const [totals, setTotals] = useState<Totals>({ gross: 0, withholding: 0, net: 0 });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true); setErr(null);
      try {
        const t = await token();
        const r = await fetch("/api/vendor/tax/withholding", { headers: { Authorization: `Bearer ${t}` } });
        if (!r.ok) throw new Error(await r.text());
        const d = await r.json() as { rows: Row[]; totals: Totals };
        setRows(d.rows || []); setTotals(d.totals);
      } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
      finally { setLoading(false); }
    })();
  }, []);

  return (
    <div style={{ color: C.text, padding: 20 }}>
      <h2 style={{ margin: 0, fontSize: 22 }}>Withholding tax</h2>
      <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4, marginBottom: 16 }}>Invoices where a withholding rule applies. The net payment is what you'll actually receive; the withheld amount is remitted on your behalf.</div>

      {err && <div style={{ color: C.danger, marginBottom: 10 }}>{err}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 14 }}>
        <Mini label="Gross invoiced" value={`$${Math.round(totals.gross).toLocaleString()}`} />
        <Mini label="Withheld" value={`$${Math.round(totals.withholding).toLocaleString()}`} color={C.warn} />
        <Mini label="Net received" value={`$${Math.round(totals.net).toLocaleString()}`} color={C.success} />
      </div>

      {loading ? <div style={{ color: C.textMuted }}>Loading…</div>
      : rows.length === 0 ? (
        <div style={{ padding: 20, textAlign: "center", color: C.textMuted, fontSize: 13, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>No withholding tax applies to your invoices.</div>
      ) : (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 100px 120px 120px 120px", padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
            <div>Invoice</div><div>Jurisdiction(s)</div><div>Rate(s)</div><div>Gross</div><div>Withheld</div><div>Net</div>
          </div>
          {rows.map((r) => (
            <div key={r.invoice_id} style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 100px 120px 120px 120px", padding: "10px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 600 }}>{r.invoice_number}</div>
                <div style={{ fontSize: 11, color: C.textMuted }}>{r.invoice_date} · due {r.due_date}</div>
              </div>
              <div style={{ color: C.textSub, fontSize: 11 }}>{[...new Set(r.calculations.map((c) => c.jurisdiction))].join(", ")}</div>
              <div style={{ color: C.textMuted }}>{r.calculations.map((c) => `${Number(c.rate_pct).toFixed(1)}%`).join(" + ")}</div>
              <div>${Number(r.gross_amount).toLocaleString()}</div>
              <div style={{ color: C.warn }}>${Number(r.withholding_amount).toLocaleString()}</div>
              <div style={{ color: C.success, fontWeight: 700 }}>${Number(r.net_payment_amount).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Mini({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ padding: 10, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 6 }}>
      <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 700, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, marginTop: 2, color: color || C.text }}>{value}</div>
    </div>
  );
}
