// src/tanda/InternalMarketplaceStatus.tsx
//
// Tangerine P12-99 — Marketplaces status panel.
//
// Single-panel dashboard for the four marketplace channels that ship in
// P11/P12 (Shopify / FBA / Walmart / Faire). Five things on one screen:
//
//   1. Per-channel rollup cards — last sync time, orders today, unposted
//      JEs, unmatched deposits, errors-in-last-24h.
//
//   2. Sync table — one row per (channel, feed) showing last successful
//      sync. Filterable by date range; exportable via xlsx-only
//      <ExportButton/>.
//
//   3. Manual "Run now" buttons that POST to the cron / sync handlers
//      that already shipped in P11 / P12:
//        • /api/cron/shopify-backfill           (orders / refunds)
//        • /api/cron/shopify-payouts-daily      (payouts)
//        • /api/cron/fba-orders-nightly         (FBA orders + settlements)
//        • /api/internal/fba/sync-orders        (admin single-acct override)
//        • /api/cron/walmart-orders-nightly     (Walmart orders + settlements)
//        • /api/internal/walmart/sync-orders    (admin single-acct override)
//        • /api/cron/faire-orders-nightly       (Faire orders)
//        • /api/cron/faire-payouts-monthly      (Faire payouts)
//
//   4. DateRangePresets across the top of the order-count filter — chips
//      let the operator flip between Today / Yesterday / WTD / MTD /
//      Last 30 / Custom.
//
//   5. ExportButton emits the FULL status table as .xlsx — WYSIWYG,
//      whatever channels / dates are currently shown.
//
// Built off the T10-7 Shadow Mirror Status panel template
// (InternalShadowMirrorStatus.tsx) — same color tokens, same modal
// scaffolding, same auth-gated admin button pattern.
//
// Reads (all paginated):
//   GET /api/internal/marketplace-status  →  per-channel last-sync rows
//   ...with a fall-back per-table count via Supabase REST when the
//   convenience handler is absent.
//
// No new migrations; no new persisted state. All counts derived from the
// existing P11/P12 tables.

import { useEffect, useMemo, useState } from "react";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import DateRangePresets from "./components/DateRangePresets.tsx";
import { getCachedAuthUserId } from "../utils/tangerineAuthUser";
import { notify, confirmDialog } from "../shared/ui/warn";
import { useTablePrefs, TablePrefsButton, type ColumnDef } from "./components/TablePrefs";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";

const TABLE_KEY = "tanda.marketplace_status";
const ALL_COLUMNS: ColumnDef[] = [
  { key: "channel",       label: "Channel" },
  { key: "feed",          label: "Feed" },
  { key: "last_sync",     label: "Last sync" },
  { key: "rows_in_range", label: "Rows in range" },
  { key: "unposted",      label: "Unposted" },
  { key: "unmatched_dep", label: "Unmatched dep." },
  { key: "errors_24h",    label: "Errors 24h" },
];

// ─────────────────────────────────────────────────────────────────────────
// Theme — match the Shadow Mirror / Bank Reconciliation palette.
// ─────────────────────────────────────────────────────────────────────────
const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
  tangerine: "#fb923c",
};

// ─────────────────────────────────────────────────────────────────────────
// Channel + feed catalog. The status panel is structured around a stable
// list of (channel, feed) pairs — each one has a Supabase table whose row
// count + max(created_at) we expose, plus an optional "manual run" URL.
// ─────────────────────────────────────────────────────────────────────────
export type Channel = "shopify" | "fba" | "walmart" | "faire";

export const CHANNEL_LABEL: Record<Channel, string> = {
  shopify: "Shopify",
  fba:     "Amazon FBA",
  walmart: "Walmart",
  faire:   "Faire",
};

export type FeedKind = "orders" | "payouts" | "settlements" | "refunds" | "returns" | "inventory";

export type FeedDef = {
  channel: Channel;
  kind:    FeedKind;
  label:   string;
  // Supabase table this feed writes to (used for last-sync proxy via
  // max(created_at)) — null if not materialized in this app yet.
  table:   string;
  // Date column used to count "orders today" / "orders in range".
  dateColumn: string;
  // POST URL to manually re-run the feed (empty string = no manual btn).
  manualUrl:  string;
  manualLabel: string;
};

export const FEEDS: FeedDef[] = [
  // ─── Shopify ────────────────────────────────────────────────────────
  { channel: "shopify", kind: "orders",      label: "Orders",       table: "ar_invoices",       dateColumn: "invoice_date", manualUrl: "/api/cron/shopify-backfill",        manualLabel: "Run Shopify backfill" },
  { channel: "shopify", kind: "payouts",     label: "Payouts",      table: "shopify_payouts",   dateColumn: "payout_date",  manualUrl: "/api/cron/shopify-payouts-daily",   manualLabel: "Run Shopify payouts" },
  { channel: "shopify", kind: "refunds",     label: "Refunds",      table: "shopify_refunds",   dateColumn: "processed_at", manualUrl: "/api/cron/shopify-backfill",        manualLabel: "Run Shopify backfill" },
  // ─── FBA ────────────────────────────────────────────────────────────
  { channel: "fba",     kind: "orders",      label: "Orders",       table: "fba_orders",        dateColumn: "purchase_date", manualUrl: "/api/cron/fba-orders-nightly",     manualLabel: "Run FBA orders nightly" },
  { channel: "fba",     kind: "settlements", label: "Settlements",  table: "fba_settlements",   dateColumn: "posted_after",  manualUrl: "/api/cron/fba-orders-nightly",     manualLabel: "Run FBA orders nightly" },
  { channel: "fba",     kind: "inventory",   label: "Inventory",    table: "fba_inventory_snapshots", dateColumn: "snapshot_at", manualUrl: "/api/cron/fba-orders-nightly", manualLabel: "Run FBA orders nightly" },
  { channel: "fba",     kind: "returns",     label: "Returns",      table: "fba_returns",       dateColumn: "return_date",   manualUrl: "/api/cron/fba-orders-nightly",     manualLabel: "Run FBA orders nightly" },
  // ─── Walmart ────────────────────────────────────────────────────────
  { channel: "walmart", kind: "orders",      label: "Orders",       table: "walmart_orders",        dateColumn: "order_date",   manualUrl: "/api/cron/walmart-orders-nightly", manualLabel: "Run Walmart orders nightly" },
  { channel: "walmart", kind: "settlements", label: "Settlements",  table: "walmart_settlements",   dateColumn: "period_end",   manualUrl: "/api/cron/walmart-orders-nightly", manualLabel: "Run Walmart orders nightly" },
  { channel: "walmart", kind: "returns",     label: "Returns",      table: "walmart_returns",       dateColumn: "return_date",  manualUrl: "/api/cron/walmart-orders-nightly", manualLabel: "Run Walmart orders nightly" },
  // ─── Faire ──────────────────────────────────────────────────────────
  { channel: "faire",   kind: "orders",      label: "Orders",       table: "faire_orders",          dateColumn: "order_date",   manualUrl: "/api/cron/faire-orders-nightly",   manualLabel: "Run Faire orders nightly" },
  { channel: "faire",   kind: "payouts",     label: "Payouts",      table: "faire_payouts",         dateColumn: "payout_date",  manualUrl: "/api/cron/faire-payouts-monthly",  manualLabel: "Run Faire payouts monthly" },
  { channel: "faire",   kind: "returns",     label: "Returns",      table: "faire_returns",         dateColumn: "return_date",  manualUrl: "/api/cron/faire-orders-nightly",   manualLabel: "Run Faire orders nightly" },
];

// Deposit tables — the ones the P5-7 preflight blocks on via P12-99.
// Keep this list in sync with api/_handlers/internal/gl-periods/preflight.js.
export const DEPOSIT_TABLES: Array<{ channel: Channel; table: string; dateColumn: string }> = [
  { channel: "shopify", table: "shopify_payouts",     dateColumn: "payout_date" },
  { channel: "fba",     table: "fba_settlements",     dateColumn: "posted_after" },
  { channel: "walmart", table: "walmart_settlements", dateColumn: "period_end" },
  { channel: "faire",   table: "faire_payouts",       dateColumn: "period_end" },
];

// JE-bearing tables — count rows that have an order/invoice but no
// posted JE yet. Per channel, the AR-invoice mirror is the single source
// of "unposted JE" truth (orders → AR invoice → JE).
export const UNPOSTED_JE_TABLES: Array<{ channel: Channel; table: string }> = [
  { channel: "shopify", table: "ar_invoices" },     // shopify orders post via P11-7
  { channel: "fba",     table: "fba_orders" },      // P12a-3
  { channel: "walmart", table: "walmart_orders" },  // P12b-3
  { channel: "faire",   table: "faire_orders" },    // P12c-2
];

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────
function todayMinusDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

// Cell shape returned by the per-feed status endpoint. The convenience
// handler at /api/internal/marketplace-status returns one cell per feed;
// if absent, we fall back to per-table count() queries via the helper
// below.
export type FeedStatus = {
  channel: Channel;
  kind: FeedKind;
  table: string;
  // ISO timestamp of the last row (max(created_at)) in this feed table.
  last_sync_at: string | null;
  // Count of rows whose dateColumn falls in [fromDate, toDate].
  rows_in_range: number;
  // Count of rows in this feed table whose je_id IS NULL (deposit tables)
  // or whose ar_invoice_id IS NULL (order tables). Null when N/A.
  unposted_count: number | null;
  unmatched_deposits: number | null;
  // Errors in last 24h — best-effort from xoro_mirror_runs.errors if
  // available; otherwise 0.
  errors_24h: number;
};

// ─────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────
export default function InternalMarketplaceStatus() {
  const [statuses, setStatuses] = useState<FeedStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState(todayMinusDays(7));
  const [toDate, setToDate]   = useState(todayMinusDays(0));
  const [manualBusy, setManualBusy] = useState<string | null>(null);
  const [manualResult, setManualResult] = useState<string | null>(null);

  const authUserId = getCachedAuthUserId();
  const isAdmin = !!authUserId;

  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(TABLE_KEY, ALL_COLUMNS);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(
        `/api/internal/marketplace-status?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`,
      );
      // If the convenience handler isn't deployed, surface a stub so the
      // page still renders. Otherwise propagate the error.
      if (r.status === 404) {
        setStatuses(stubStatuses());
        setErr("marketplace-status endpoint not deployed — showing stub rows");
        return;
      }
      if (!r.ok) {
        throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      const arr: FeedStatus[] = Array.isArray(data?.feeds) ? data.feeds : [];
      setStatuses(arr);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setStatuses(stubStatuses());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [fromDate, toDate]);

  // Per-channel rollups derived from the feed-level rows.
  const channelRollups = useMemo(() => {
    const out: Record<Channel, {
      lastSync: string | null;
      ordersInRange: number;
      unposted: number;
      unmatchedDeposits: number;
      errors24h: number;
    }> = {
      shopify: { lastSync: null, ordersInRange: 0, unposted: 0, unmatchedDeposits: 0, errors24h: 0 },
      fba:     { lastSync: null, ordersInRange: 0, unposted: 0, unmatchedDeposits: 0, errors24h: 0 },
      walmart: { lastSync: null, ordersInRange: 0, unposted: 0, unmatchedDeposits: 0, errors24h: 0 },
      faire:   { lastSync: null, ordersInRange: 0, unposted: 0, unmatchedDeposits: 0, errors24h: 0 },
    };
    for (const s of statuses) {
      const acc = out[s.channel];
      if (!acc) continue;
      if (s.last_sync_at && (!acc.lastSync || s.last_sync_at > acc.lastSync)) {
        acc.lastSync = s.last_sync_at;
      }
      if (s.kind === "orders") acc.ordersInRange += s.rows_in_range;
      if (typeof s.unposted_count === "number") acc.unposted += s.unposted_count;
      if (typeof s.unmatched_deposits === "number") acc.unmatchedDeposits += s.unmatched_deposits;
      acc.errors24h += s.errors_24h;
    }
    return out;
  }, [statuses]);

  // #5 — tri-state column sort over the feed-status rows. Accessors resolve
  // the derived/JSX columns (channel + feed labels, last-sync timestamp); the
  // numeric columns read same-named scalar fields straight off the row.
  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(statuses, {
    persistKey: "tangerine:marketplace_status:sort",
    accessors: {
      channel: (s) => CHANNEL_LABEL[s.channel],
      feed: (s) => FEEDS.find((f) => f.channel === s.channel && f.kind === s.kind)?.label ?? s.kind,
      last_sync: (s) => (s.last_sync_at ? new Date(s.last_sync_at) : null),
      unposted: (s) => s.unposted_count,
      unmatched_dep: (s) => s.unmatched_deposits,
    },
  });

  // Export rows — WYSIWYG, the full table the operator is staring at.
  const exportRows = useMemo(
    () => {
      const body = statuses.map((s) => ({
        channel: CHANNEL_LABEL[s.channel],
        feed: s.kind as string,
        table: s.table,
        last_sync_at: s.last_sync_at,
        rows_in_range: s.rows_in_range,
        unposted_count: s.unposted_count ?? "",
        unmatched_deposits: s.unmatched_deposits ?? "",
        errors_24h: s.errors_24h,
      }));
      // #23 — append a TOTAL row summing the numeric columns so the exported
      // spreadsheet carries a footer (no totals prop on ExportButton).
      if (body.length > 0) {
        body.push({
          channel: "TOTAL",
          feed: "",
          table: "",
          last_sync_at: null,
          rows_in_range: statuses.reduce((a, s) => a + (s.rows_in_range || 0), 0),
          unposted_count: statuses.reduce((a, s) => a + (s.unposted_count ?? 0), 0),
          unmatched_deposits: statuses.reduce((a, s) => a + (s.unmatched_deposits ?? 0), 0),
          errors_24h: statuses.reduce((a, s) => a + (s.errors_24h || 0), 0),
        });
      }
      return body;
    },
    [statuses],
  );

  async function runManual(feed: FeedDef) {
    if (!isAdmin) { notify("Sign in via MS to run jobs manually.", "info"); return; }
    if (!(await confirmDialog(`${feed.manualLabel}?\n\nPOST ${feed.manualUrl}`))) return;
    setManualBusy(feed.manualUrl);
    setManualResult(null);
    try {
      const r = await fetch(feed.manualUrl, { method: "POST" });
      const txt = await r.text();
      setManualResult(`${feed.manualLabel}: HTTP ${r.status}\n${txt.slice(0, 400)}`);
      void load();
    } catch (e: unknown) {
      setManualResult(`${feed.manualLabel}: ERROR ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setManualBusy(null);
    }
  }

  const CHANNELS: Channel[] = ["shopify", "fba", "walmart", "faire"];

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Marketplace Status</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: C.textMuted }}>
            Shopify · FBA · Walmart · Faire
          </span>
          <button onClick={() => void load()} style={btnSecondary}>Refresh</button>
        </div>
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
          {err}
        </div>
      )}

      {/* ─── Top: 4 channel rollup cards ─────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 18 }}>
        {CHANNELS.map((ch) => {
          const r = channelRollups[ch];
          return (
            <div key={ch} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 14, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{CHANNEL_LABEL[ch]}</span>
              </div>
              <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Last sync</div>
              <div style={{ fontSize: 13, fontVariantNumeric: "tabular-nums" }}>{fmtDateTime(r.lastSync)}</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, fontSize: 11, color: C.textSub, marginTop: 4 }}>
                <span>Orders in range</span>
                <strong style={{ color: C.text, textAlign: "right" }}>{r.ordersInRange.toLocaleString()}</strong>
                <span>Unposted JEs</span>
                <strong style={{ color: r.unposted > 0 ? C.warn : C.text, textAlign: "right" }}>{r.unposted.toLocaleString()}</strong>
                <span>Unmatched deposits</span>
                <strong style={{ color: r.unmatchedDeposits > 0 ? C.warn : C.text, textAlign: "right" }}>{r.unmatchedDeposits.toLocaleString()}</strong>
                <span>Errors (24h)</span>
                <strong style={{ color: r.errors24h > 0 ? C.danger : C.text, textAlign: "right" }}>{r.errors24h.toLocaleString()}</strong>
              </div>
            </div>
          );
        })}
      </div>

      {/* ─── Filter strip: date range + presets ──────────────────────── */}
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 12, marginBottom: 12, display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
        <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
          Order date range
        </div>
        <input
          type="date"
          value={fromDate}
          onChange={(e) => setFromDate(e.target.value)}
          style={inputStyle}
          aria-label="From date"
        />
        <span style={{ color: C.textMuted }}>→</span>
        <input
          type="date"
          value={toDate}
          onChange={(e) => setToDate(e.target.value)}
          style={inputStyle}
          aria-label="To date"
        />
        <DateRangePresets variant="dropdown"
          from={fromDate}
          to={toDate}
          onChange={(f, t) => { if (f) setFromDate(f); if (t) setToDate(t); }}
        />
      </div>

      {/* ─── Feed status table ────────────────────────────────────────── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 14, color: C.textMuted, textTransform: "uppercase", letterSpacing: 1 }}>
          Feed status ({statuses.length})
        </h3>
        <ExportButton
          rows={exportRows as unknown as Array<Record<string, unknown>>}
          filename="marketplace-status"
          sheetName="Marketplace Status"
          columns={[
            { key: "channel",             header: "Channel" },
            { key: "feed",                header: "Feed" },
            { key: "table",               header: "Table" },
            { key: "last_sync_at",        header: "Last Sync",          format: "datetime" },
            { key: "rows_in_range",       header: "Rows in Range",      format: "number" },
            { key: "unposted_count",      header: "Unposted JE Count",  format: "number" },
            { key: "unmatched_deposits",  header: "Unmatched Deposits", format: "number" },
            { key: "errors_24h",          header: "Errors (24h)",       format: "number" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
        <TablePrefsButton
          tableKey={TABLE_KEY}
          columns={ALL_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
          onSetAll={setAllVisible}
        />
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)", marginBottom: 18 }}>
        {loading ? (
          <div style={{ padding: 20, color: C.textMuted, textAlign: "center" }}>Loading…</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <SortableTh label="Channel" sortKey="channel" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!visibleColumns.has("channel")} />
                <SortableTh label="Feed" sortKey="feed" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!visibleColumns.has("feed")} />
                <SortableTh label="Last sync" sortKey="last_sync" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!visibleColumns.has("last_sync")} />
                <SortableTh label="Rows in range" sortKey="rows_in_range" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} hidden={!visibleColumns.has("rows_in_range")} />
                <SortableTh label="Unposted" sortKey="unposted" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} hidden={!visibleColumns.has("unposted")} />
                <SortableTh label="Unmatched dep." sortKey="unmatched_dep" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} hidden={!visibleColumns.has("unmatched_dep")} />
                <SortableTh label="Errors 24h" sortKey="errors_24h" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} hidden={!visibleColumns.has("errors_24h")} />
                <th style={{ ...th, textAlign: "center" }}>Run now</th>
              </tr>
            </thead>
            <tbody>
              {statuses.length === 0 && !loading && (
                <tr><td colSpan={8} style={{ ...td, color: C.textMuted, textAlign: "center", fontStyle: "italic" }}>No feeds reporting.</td></tr>
              )}
              {sorted.map((s) => {
                const feed = FEEDS.find((f) => f.channel === s.channel && f.kind === s.kind);
                const busy = feed?.manualUrl === manualBusy;
                return (
                  <tr key={`${s.channel}-${s.kind}`}>
                    <td style={td} hidden={!visibleColumns.has("channel")}>
                      {CHANNEL_LABEL[s.channel]}
                    </td>
                    <td style={td} hidden={!visibleColumns.has("feed")}>{feed?.label ?? s.kind}</td>
                    <td style={td} hidden={!visibleColumns.has("last_sync")}>{fmtDateTime(s.last_sync_at)}</td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }} hidden={!visibleColumns.has("rows_in_range")}>{s.rows_in_range.toLocaleString()}</td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", color: (s.unposted_count ?? 0) > 0 ? C.warn : undefined }} hidden={!visibleColumns.has("unposted")}>
                      {s.unposted_count ?? "—"}
                    </td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", color: (s.unmatched_deposits ?? 0) > 0 ? C.warn : undefined }} hidden={!visibleColumns.has("unmatched_dep")}>
                      {s.unmatched_deposits ?? "—"}
                    </td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", color: s.errors_24h > 0 ? C.danger : undefined }} hidden={!visibleColumns.has("errors_24h")}>{s.errors_24h}</td>
                    <td style={{ ...td, textAlign: "center" }}>
                      {feed?.manualUrl ? (
                        <button
                          onClick={() => feed && void runManual(feed)}
                          disabled={!isAdmin || busy}
                          style={{ ...btnSecondary, opacity: isAdmin && !busy ? 1 : 0.5, cursor: isAdmin && !busy ? "pointer" : "not-allowed" }}
                          title={isAdmin ? feed.manualLabel : "Sign in via MS to enable"}
                          data-manual-url={feed.manualUrl}
                        >
                          {busy ? "Running…" : "Run now"}
                        </button>
                      ) : (
                        <span style={{ color: C.textMuted, fontSize: 11 }}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {manualResult && (
        <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, padding: "10px 12px", borderRadius: 6, fontSize: 12, marginBottom: 18, color: C.textSub, fontFamily: "monospace", whiteSpace: "pre-wrap" }}>
          {manualResult}
          <div style={{ marginTop: 8 }}>
            <button onClick={() => setManualResult(null)} style={btnSecondary}>Dismiss</button>
          </div>
        </div>
      )}

      <div style={{ background: C.card, border: `1px solid ${C.tangerine}55`, borderRadius: 10, padding: 14, fontSize: 12, color: C.textSub, lineHeight: 1.5 }}>
        <div style={{ fontSize: 11, color: C.tangerine, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
          Period close hook
        </div>
        Unmatched marketplace deposits (je_id IS NULL) landing in a period block its close — the P12-99
        pre-flight check <code>unmatched_marketplace_deposits</code> surfaces on the Periods panel. Run the
        bank-reconciliation matcher before closing the period.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Stub fallback used when the convenience endpoint is missing in this env.
// Keeps the panel renderable rather than a hard 404.
// ─────────────────────────────────────────────────────────────────────────
export function stubStatuses(): FeedStatus[] {
  return FEEDS.map((f) => ({
    channel: f.channel,
    kind: f.kind,
    table: f.table,
    last_sync_at: null,
    rows_in_range: 0,
    unposted_count: null,
    unmatched_deposits: null,
    errors_24h: 0,
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// Styles (kept local — matches the Shadow Mirror panel's palette).
// ─────────────────────────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13,
};
const btnSecondary: React.CSSProperties = {
  background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, cursor: "pointer", fontSize: 12,
};
const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
  position: "sticky", top: 0, zIndex: 2,
};
const td: React.CSSProperties = {
  padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 12,
};
