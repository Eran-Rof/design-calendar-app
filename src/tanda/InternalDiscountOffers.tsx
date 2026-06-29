import { useEffect, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import { fmtMoney } from "../shared/money";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { fmtDateDisplay } from "../utils/tandaTypes";
import SearchableSelect from "./components/SearchableSelect";
import { useSort, type SortDir } from "./hooks/useSort";

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

  // #5 Sortable columns — div-grid "table".
  const { sorted: sortedOffers, sortKey, sortDir, onHeaderClick } = useSort(offers, {
    persistKey: "tangerine:discountoffers:sort",
    accessors: {
      vendor: (o) => o.vendor?.name || "",
      early_pay: (o) => o.early_payment_date,
      days_early: (o) => (o.days_early ?? null),
      discount: (o) => Number(o.discount_amount),
      net: (o) => Number(o.net_payment_amount),
      apr: (o) => (o.annualized_return_pct ?? null),
      status: (o) => o.status,
      expires: (o) => o.expires_at,
    },
  });

  async function runJob() {
    if (!(await confirmDialog("Run the discount offer generator now for this entity?"))) return;
    const r = await fetch("/api/internal/discount-offers/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entity_id: entityId }),
    });
    if (!r.ok) { notify(await r.text(), "error"); return; }
    const d = await r.json() as { created: Offer[]; skipped: { invoice_id: string; reason: string }[] };
    notify(`Created ${d.created.length} offers. Skipped ${d.skipped.length}.`, "success");
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
          <SearchableSelect
            value={entityId || null}
            onChange={(v) => setEntityId(v)}
            options={entities.map((e) => ({ value: e.id, label: e.name }))}
            inputStyle={selectSt}
          />
          <SearchableSelect
            value={status || null}
            onChange={(v) => setStatus(v)}
            options={[
              { value: "", label: "All statuses" },
              { value: "offered", label: "Offered" },
              { value: "accepted", label: "Accepted" },
              { value: "rejected", label: "Rejected" },
              { value: "expired", label: "Expired" },
              { value: "paid", label: "Paid" },
            ]}
            placeholder="All statuses"
            inputStyle={selectSt}
          />
          <button onClick={() => void runJob()} style={btnPrimary}>Generate now</button>
          <ExportButton
            rows={offers.map((o) => ({
              ...o,
              vendor_name: o.vendor?.name || o.vendor_id,
              invoice_number: o.invoice?.invoice_number || null,
            })) as unknown as Array<Record<string, unknown>>}
            filename="discount-offers"
            sheetName="Discount Offers"
            columns={[
              { key: "vendor_name",              header: "Vendor" },
              { key: "invoice_number",           header: "Invoice #" },
              { key: "original_due_date",        header: "Original Due",  format: "date" },
              { key: "early_payment_date",       header: "Early Pay",     format: "date" },
              { key: "days_early",               header: "Days Early",    format: "number" },
              { key: "discount_pct",             header: "Discount %",    format: "number" },
              { key: "discount_amount",          header: "Discount $",    format: "number" },
              { key: "net_payment_amount",       header: "Net Payment",   format: "number" },
              { key: "annualized_return_pct",    header: "APR %",         format: "number" },
              { key: "status",                   header: "Status" },
              { key: "offered_at",               header: "Offered",       format: "datetime" },
              { key: "expires_at",               header: "Expires",       format: "datetime" },
            ] as ExportColumn<Record<string, unknown>>[]}
          />
        </div>
      </div>

      {analytics && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 14 }}>
          <Stat label="Offers made (YTD)" value={String(analytics.total_offers_made)} />
          <Stat label="Acceptance rate" value={`${analytics.acceptance_rate_pct.toFixed(0)}%`} color={C.primary} />
          <Stat label="Discount captured" value={`$${fmtMoney(analytics.total_discount_captured)}`} color={C.success} />
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
            <SortHeader label="Vendor / Invoice" k="vendor" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} />
            <SortHeader label="Early pay" k="early_pay" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} />
            <SortHeader label="Days early" k="days_early" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} />
            <SortHeader label="Discount" k="discount" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} />
            <SortHeader label="Net" k="net" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} />
            <SortHeader label="APR" k="apr" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} />
            <SortHeader label="Status" k="status" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} />
            <SortHeader label="Expires" k="expires" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} />
          </div>
          {sortedOffers.map((o) => (
            <div key={o.id} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 100px 120px 100px 100px 100px 110px", padding: "10px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 600 }}>{o.vendor?.name || "—"}</div>
                <div style={{ fontSize: 11, color: C.textMuted }}>Inv {o.invoice?.invoice_number || "—"}</div>
              </div>
              <div style={{ color: C.textSub, fontSize: 12 }}>{o.early_payment_date}</div>
              <div style={{ color: C.textMuted }}>{o.days_early ?? "—"}</div>
              <div><strong>${Number(o.discount_amount).toFixed(2)}</strong> <span style={{ color: C.textMuted, fontSize: 11 }}>({Number(o.discount_pct).toFixed(2)}%)</span></div>
              <div>${Number(o.net_payment_amount).toLocaleString()}</div>
              <div style={{ color: C.warn, fontWeight: 600 }}>{o.annualized_return_pct != null ? `${o.annualized_return_pct.toFixed(1)}%` : "—"}</div>
              <div><StatusChip status={o.status} /></div>
              <div style={{ color: C.textMuted, fontSize: 11 }}>{fmtDateDisplay(o.expires_at)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Clickable sortable header cell for the div-grid "table".
function SortHeader({ label, k, activeKey, dir, onSort }: {
  label: string; k: string; activeKey: string | null; dir: SortDir; onSort: (key: string) => void;
}) {
  const active = activeKey === k;
  const indicator = active ? (dir === "asc" ? " ▲" : " ▼") : " ▲";
  return (
    <div onClick={() => onSort(k)} title={`Sort by ${label}`} style={{ cursor: "pointer", userSelect: "none", ...(active ? { color: C.text } : null) }}>
      {label}
      <span aria-hidden="true" style={{ opacity: active ? 1 : 0 }}>{indicator}</span>
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

const selectSt = { padding: "6px 10px", background: C.card, border: `1px solid ${C.cardBdr}`, color: C.text, borderRadius: 6, fontSize: 13, colorScheme: "dark" } as const;
const btnPrimary = { padding: "8px 14px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
