import { useEffect, useMemo, useState } from "react";
import { BarChart, Bar, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { TH } from "../utils/theme";
import { S } from "../utils/styles";

interface SpendMonth { month: string; total: number; }
interface SpendVendor { vendor_id: string; vendor_name: string | null; total: number; }
interface SpendVendorMonth { vendor_id: string; vendor_name: string | null; month: string; total: number; }
interface SpendCategory { category: string; total: number; }

interface SpendResponse {
  period: { from: string; to: string };
  grand_total: number;
  by_month: SpendMonth[];
  by_vendor: SpendVendor[];
  by_vendor_month: SpendVendorMonth[];
  by_category: SpendCategory[];
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function fmtMoneyShort(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
}

export default function SpendReport() {
  const [data, setData] = useState<SpendResponse | null>(null);
  const [vendors, setVendors] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const year = new Date().getFullYear();
  const [fromDate, setFromDate] = useState(`${year}-01-01`);
  const [toDate, setToDate] = useState(new Date().toISOString().slice(0, 10));
  const [vendorFilter, setVendorFilter] = useState("");

  async function load() {
    setLoading(true); setErr(null);
    try {
      const q = new URLSearchParams();
      q.set("from", fromDate);
      q.set("to", toDate);
      if (vendorFilter) q.set("vendor_id", vendorFilter);
      const r = await fetch(`/api/internal/reports/spend?${q.toString()}`);
      if (!r.ok) throw new Error(`spend: ${r.status}`);
      setData(await r.json() as SpendResponse);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }

  useEffect(() => {
    void load();
    (async () => {
      const r = await fetch("/api/internal/reports/vendors");
      if (r.ok) {
        const rows = await r.json() as { vendor_id: string; name: string }[];
        setVendors(rows.map((x) => ({ id: x.vendor_id, name: x.name })).sort((a, b) => a.name.localeCompare(b.name)));
      }
    })();
    // eslint-disable-next-line
  }, []);

  const top10Vendors = useMemo(() => (data?.by_vendor ?? []).slice(0, 10).map((v) => ({
    name: (v.vendor_name ?? "—").slice(0, 22),
    total: v.total,
  })), [data]);

  const monthSeries = useMemo(() => (data?.by_month ?? []).map((m) => ({
    month: m.month, total: m.total,
  })), [data]);

  return (
    <div>
      <div style={{ ...S.card, marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ fontSize: 13, color: TH.textSub, fontWeight: 600 }}>Period</div>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={{ ...S.inp, marginBottom: 0, flex: "0 1 160px" }} />
          <span style={{ color: TH.textMuted }}>→</span>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={{ ...S.inp, marginBottom: 0, flex: "0 1 160px" }} />
          <select value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)} style={{ ...S.inp, marginBottom: 0, flex: "0 1 220px" }}>
            <option value="">All vendors</option>
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
          <button onClick={() => void load()} style={{ ...S.btn, padding: "7px 14px", fontSize: 13 }}>Refresh</button>
          {data && (
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ fontSize: 12, color: TH.textMuted, fontWeight: 600, textTransform: "uppercase" }}>Grand total</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: TH.primary }}>{fmtMoney(data.grand_total)}</div>
            </div>
          )}
        </div>
      </div>

      {loading && <div style={{ color: TH.textMuted, padding: 20 }}>Loading…</div>}
      {err && <div style={{ color: "#B91C1C", background: "#FEF2F2", border: "1px solid #FCA5A5", padding: "10px 14px", borderRadius: 8 }}>Error: {err}</div>}

      {!loading && !err && data && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
            <div style={{ ...S.card, padding: "14px 18px" }}>
              <div style={{ fontSize: 12, color: TH.textMuted, fontWeight: 700, textTransform: "uppercase", marginBottom: 10 }}>Spend over time</div>
              <div style={{ height: 280 }}>
                {monthSeries.length === 0 ? (
                  <div style={{ color: TH.textMuted, fontSize: 13, textAlign: "center", padding: 40 }}>No data in this period.</div>
                ) : (
                  <ResponsiveContainer>
                    <LineChart data={monthSeries}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                      <XAxis dataKey="month" stroke={TH.textMuted} fontSize={11} />
                      <YAxis stroke={TH.textMuted} fontSize={11} tickFormatter={(v) => fmtMoneyShort(v)} />
                      <Tooltip formatter={(v: number) => fmtMoney(v)} />
                      <Line type="monotone" dataKey="total" stroke={TH.primary} strokeWidth={2} dot={{ r: 4 }} name="Total spend" />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            <div style={{ ...S.card, padding: "14px 18px" }}>
              <div style={{ fontSize: 12, color: TH.textMuted, fontWeight: 700, textTransform: "uppercase", marginBottom: 10 }}>Top 10 vendors</div>
              <div style={{ height: 280 }}>
                {top10Vendors.length === 0 ? (
                  <div style={{ color: TH.textMuted, fontSize: 13, textAlign: "center", padding: 40 }}>No data.</div>
                ) : (
                  <ResponsiveContainer>
                    <BarChart data={top10Vendors} layout="vertical" margin={{ left: 30 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                      <XAxis type="number" stroke={TH.textMuted} fontSize={11} tickFormatter={(v) => fmtMoneyShort(v)} />
                      <YAxis dataKey="name" type="category" stroke={TH.textMuted} fontSize={10} width={150} />
                      <Tooltip formatter={(v: number) => fmtMoney(v)} />
                      <Bar dataKey="total" fill={TH.primary} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
              <div style={{ padding: "12px 18px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 13, fontWeight: 700, color: TH.text }}>Vendor breakdown</div>
              <div style={{ maxHeight: 320, overflow: "auto" }}>
                {data.by_vendor.length === 0 ? (
                  <div style={{ padding: 20, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No spend.</div>
                ) : data.by_vendor.map((v) => (
                  <div key={v.vendor_id} style={{ display: "grid", gridTemplateColumns: "1fr 120px", padding: "10px 18px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center" }}>
                    <div style={{ color: TH.text }}>{v.vendor_name ?? "(unknown)"}</div>
                    <div style={{ textAlign: "right", fontWeight: 600, color: TH.text }}>{fmtMoney(v.total)}</div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
              <div style={{ padding: "12px 18px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 13, fontWeight: 700, color: TH.text }}>Category breakdown</div>
              <div style={{ maxHeight: 320, overflow: "auto" }}>
                {data.by_category.length === 0 ? (
                  <div style={{ padding: 20, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No spend.</div>
                ) : data.by_category.map((c) => (
                  <div key={c.category} style={{ display: "grid", gridTemplateColumns: "1fr 120px", padding: "10px 18px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center" }}>
                    <div style={{ color: TH.text }}>{c.category}</div>
                    <div style={{ textAlign: "right", fontWeight: 600, color: TH.text }}>{fmtMoney(c.total)}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
