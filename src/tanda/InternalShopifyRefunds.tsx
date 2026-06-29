// src/tanda/InternalShopifyRefunds.tsx
//
// Tangerine P11-7 — Shopify refunds reports panel.
//
// Read-only admin surface listing shopify_refunds. P11-6 produces the rows
// (webhook handler creates sibling AR credit memos for partial refunds and
// credits 4500 Restocking Fee Income via restocking_fee_cents per D8). This
// panel lets the operator audit the trail: refund date, parent order
// number, refund_type (full/partial), refund_amount, restocking_fee,
// linked AR credit memo (click-through to InternalARInvoices).
//
// Read path: supabase-js / REST against shopify_refunds + shopify_orders
// (joined for order_number). RLS is anon_all_* + auth_internal_* per
// P11-1 — anon callers see everything, authenticated callers are scoped to
// their entity_users membership.
//
// Standard panel cross-cutters wired up:
//   - <DateRangePresets> (T7) — date filter chips
//   - <ExportButton> (T3/T8) — xlsx-only export of the visible rows

import { useEffect, useMemo, useState } from "react";
import SearchableSelect from "./components/SearchableSelect";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import DateRangePresets from "./components/DateRangePresets.tsx";
import { SB_URL, SB_HEADERS } from "../utils/supabase";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import { fmtDateDisplay } from "../utils/tandaTypes";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";

// Universal column-visibility registry for this panel (operator ask #1).
const SHOPIFY_REFUNDS_TABLE_KEY = "tangerine:shopifyrefunds:columns";
const SHOPIFY_REFUND_COLUMNS: ColumnDef[] = [
  { key: "refund_date",    label: "Refund Date" },
  { key: "order",          label: "Order #" },
  { key: "type",           label: "Type" },
  { key: "refund_amount",  label: "Refund Amount" },
  { key: "restocking_fee", label: "Restocking Fee" },
  { key: "credit_memo",    label: "AR Credit Memo" },
];

type RefundType = "full" | "partial";

type ShopifyRefundRow = {
  id: string;
  entity_id: string;
  shopify_order_id: string;
  shopify_refund_id: string;
  refund_type: RefundType;
  refund_amount_cents: string;
  restocking_fee_cents: string;
  processed_at: string;          // timestamptz ISO string
  ar_credit_memo_id: string | null;
  je_id: string | null;
  created_at: string;
};

type ShopifyOrderLite = {
  id: string;
  order_number: string;
};

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
  colorScheme: "dark",
};
const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
  position: "sticky", top: 0, zIndex: 2,
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13,
};
const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};

function fmtCents(c: string | number | null | undefined): string {
  if (c == null) return "$0.00";
  const bi = typeof c === "bigint" ? c : BigInt(String(c).replace(/[^-0-9]/g, "") || "0");
  const neg = bi < 0n;
  const abs = neg ? -bi : bi;
  const whole = (abs / 100n).toString();
  const frac = (abs % 100n).toString().padStart(2, "0");
  const w = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${w}.${frac}`;
}

const fmtDate = fmtDateDisplay;

function refundTypeColor(t: RefundType): string {
  return t === "full" ? C.danger : C.warn;
}

export default function InternalShopifyRefunds() {
  const [rows, setRows] = useState<ShopifyRefundRow[]>([]);
  const [orderMap, setOrderMap] = useState<Record<string, string>>({}); // shopify_orders.id → order_number
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Filters
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [typeFilter, setTypeFilter] = useState<RefundType | "">("");
  const [limit, setLimit] = useState(200);

  // Wave 5 — universal column show/hide.
  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(
    SHOPIFY_REFUNDS_TABLE_KEY,
    SHOPIFY_REFUND_COLUMNS,
  );
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      // Build the PostgREST query against shopify_refunds. order=processed_at.desc
      // to match the panel-wide convention (newest first). entity_id is RLS-scoped
      // for authenticated callers; anon callers see all rows.
      const params = new URLSearchParams();
      params.set("select", "id,entity_id,shopify_order_id,shopify_refund_id,refund_type,refund_amount_cents,restocking_fee_cents,processed_at,ar_credit_memo_id,je_id,created_at");
      params.set("order", "processed_at.desc");
      params.set("limit", String(limit));
      if (typeFilter) params.append("refund_type", `eq.${typeFilter}`);
      if (fromDate)  params.append("processed_at", `gte.${fromDate}`);
      if (toDate)    params.append("processed_at", `lte.${toDate}T23:59:59`);

      const r = await fetch(`${SB_URL}/rest/v1/shopify_refunds?${params.toString()}`, { headers: SB_HEADERS });
      if (!r.ok) throw new Error(`shopify_refunds: HTTP ${r.status}`);
      const refundRows = (await r.json()) as ShopifyRefundRow[];
      setRows(refundRows);

      // Hydrate parent order numbers in one round-trip via PostgREST IN list.
      // shopify_orders is also entity-scoped; the same RLS shape applies.
      const ids = Array.from(new Set(refundRows.map((x) => x.shopify_order_id))).filter(Boolean);
      if (ids.length === 0) {
        setOrderMap({});
      } else {
        const orderParams = new URLSearchParams();
        orderParams.set("select", "id,order_number");
        orderParams.set("id", `in.(${ids.join(",")})`);
        const or = await fetch(`${SB_URL}/rest/v1/shopify_orders?${orderParams.toString()}`, { headers: SB_HEADERS });
        if (!or.ok) throw new Error(`shopify_orders: HTTP ${or.status}`);
        const orderRows = (await or.json()) as ShopifyOrderLite[];
        const map: Record<string, string> = {};
        for (const o of orderRows) map[o.id] = o.order_number;
        setOrderMap(map);
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [typeFilter, fromDate, toDate, limit]);

  const exportRows = useMemo(() => {
    const body = rows.map((r) => ({
      processed_at:           r.processed_at,
      order_number:           orderMap[r.shopify_order_id] || "—",
      refund_type:            r.refund_type,
      refund_amount_cents:    r.refund_amount_cents,
      restocking_fee_cents:   r.restocking_fee_cents,
      ar_credit_memo_id:      r.ar_credit_memo_id || "",
      je_id:                  r.je_id || "",
      shopify_refund_id:      r.shopify_refund_id,
    })) as Array<Record<string, unknown>>;
    // #23 — append a TOTAL row summing the currency_cents columns (guard empty).
    // processed_at left blank so the date column doesn't get a non-date value;
    // "TOTAL" lands in the Order # text column.
    if (body.length > 0) {
      const sumCents = (k: "refund_amount_cents" | "restocking_fee_cents") =>
        rows.reduce((s, r) => s + Number(BigInt(String(r[k] || "0").replace(/[^-0-9]/g, "") || "0")), 0);
      body.push({
        processed_at:         "",
        order_number:         "TOTAL",
        refund_type:          "",
        refund_amount_cents:  String(sumCents("refund_amount_cents")),
        restocking_fee_cents: String(sumCents("restocking_fee_cents")),
        ar_credit_memo_id:    "",
        je_id:                "",
        shopify_refund_id:    "",
      });
    }
    return body;
  }, [rows, orderMap]);

  // #5 — tri-state column sort. Derived columns get accessors: refund date by
  // timestamp, order # via orderMap, amounts numerically from the cents strings.
  // AR Credit Memo is a JSX-only link column → stays a plain <th> (inert).
  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "tangerine:shopifyrefunds:sort",
    accessors: {
      refund_date: (r) => new Date(r.processed_at).getTime(),
      order: (r) => orderMap[r.shopify_order_id] || "",
      type: (r) => r.refund_type,
      refund_amount: (r) => Number(BigInt(String(r.refund_amount_cents || "0").replace(/[^-0-9]/g, "") || "0")),
      restocking_fee: (r) => Number(BigInt(String(r.restocking_fee_cents || "0").replace(/[^-0-9]/g, "") || "0")),
    },
  });

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Shopify Refunds</h2>
        <span style={{ fontSize: 12, color: C.textMuted }}>
          Restocking fees credit 4500 Restocking Fee Income (D8).
        </span>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <SearchableSelect
          value={typeFilter}
          onChange={(v) => setTypeFilter(v as RefundType | "")}
          inputStyle={{ ...inputStyle, width: 150 }}
          options={[
            { value: "", label: "All types" },
            { value: "full", label: "Full" },
            { value: "partial", label: "Partial" },
          ]}
        />
        <input
          type="date" placeholder="From" value={fromDate}
          onChange={(e) => setFromDate(e.target.value)}
          style={{ ...inputStyle, width: 140 }}
        />
        <input
          type="date" placeholder="To" value={toDate}
          onChange={(e) => setToDate(e.target.value)}
          style={{ ...inputStyle, width: 140 }}
        />
        <DateRangePresets variant="dropdown"
          from={fromDate}
          to={toDate}
          onChange={(f, t) => { setFromDate(f); setToDate(t); }}
        />
        <SearchableSelect
          value={String(limit)}
          onChange={(v) => setLimit(Number(v))}
          inputStyle={{ ...inputStyle, width: 110 }}
          options={[
            { value: "50", label: "Limit 50" },
            { value: "100", label: "Limit 100" },
            { value: "200", label: "Limit 200" },
            { value: "500", label: "Limit 500" },
          ]}
        />
        <button onClick={() => void load()} style={btnSecondary}>Refresh</button>
        <TablePrefsButton
          tableKey={SHOPIFY_REFUNDS_TABLE_KEY}
          columns={SHOPIFY_REFUND_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
        />
        <ExportButton
          rows={exportRows}
          filename="shopify-refunds"
          sheetName="Shopify Refunds"
          columns={[
            { key: "processed_at",         header: "Refund Date",  format: "date" },
            { key: "order_number",         header: "Order #" },
            { key: "refund_type",          header: "Type" },
            { key: "refund_amount_cents",  header: "Refund Amount",  format: "currency_cents" },
            { key: "restocking_fee_cents", header: "Restocking Fee", format: "currency_cents" },
            { key: "ar_credit_memo_id",    header: "AR Credit Memo" },
            { key: "je_id",                header: "Journal Entry" },
            { key: "shopify_refund_id",    header: "Shopify Refund ID" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          Error: {err}
        </div>
      )}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No Shopify refunds.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <SortableTh label="Refund Date" sortKey="refund_date" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={{ ...th, width: 130 }} hidden={!isVisible("refund_date")} />
                <SortableTh label="Order #" sortKey="order" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={{ ...th, width: 130 }} hidden={!isVisible("order")} />
                <SortableTh label="Type" sortKey="type" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={{ ...th, width: 100 }} hidden={!isVisible("type")} />
                <SortableTh label="Refund Amount" sortKey="refund_amount" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} hidden={!isVisible("refund_amount")} />
                <SortableTh label="Restocking Fee" sortKey="restocking_fee" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} hidden={!isVisible("restocking_fee")} />
                <th style={th} hidden={!isVisible("credit_memo")}>AR Credit Memo</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const hasRestock = BigInt(r.restocking_fee_cents || "0") > 0n;
                return (
                  <tr key={r.id}>
                    <td style={td} hidden={!isVisible("refund_date")}>{fmtDate(r.processed_at)}</td>
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }} hidden={!isVisible("order")}>
                      {orderMap[r.shopify_order_id] || "—"}
                    </td>
                    <td style={td} hidden={!isVisible("type")}>
                      <span style={{ color: refundTypeColor(r.refund_type), fontWeight: 600, textTransform: "uppercase" }}>
                        ● {r.refund_type}
                      </span>
                    </td>
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", textAlign: "right" }} hidden={!isVisible("refund_amount")}>
                      {fmtCents(r.refund_amount_cents)}
                    </td>
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", textAlign: "right", color: hasRestock ? C.success : C.textMuted }} hidden={!isVisible("restocking_fee")}>
                      {fmtCents(r.restocking_fee_cents)}
                    </td>
                    <td style={td} hidden={!isVisible("credit_memo")}>
                      {r.ar_credit_memo_id ? (
                        <a
                          href={`/tangerine?module=ar_invoices&id=${r.ar_credit_memo_id}`}
                          style={{ color: C.primary, fontSize: 11 }}
                        >
                          View credit memo
                        </a>
                      ) : (
                        <span style={{ color: C.textMuted, fontSize: 11 }}>(none)</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
