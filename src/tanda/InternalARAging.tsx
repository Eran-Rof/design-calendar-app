// src/tanda/InternalARAging.tsx
//
// Tangerine P4-6 — AR Aging admin panel.
// Reads /api/internal/ar-aging (default mode = v_ar_aging using CURRENT_DATE;
// pass ?as_of=YYYY-MM-DD to use the parameterized RPC).
//
// Rows show per-customer open balance + 6 bucket columns (current / 1-30 /
// 31-60 / 61-90 / 91-120 / 120+ — exactly the report SQL's buckets).
//
// Drill-through Phase 2: every bucket cell, row total, and column total is
// clickable → AgingDrillModal lists the open invoices behind the number, each
// linking on to the invoice and its JE. Deep-linkable:
//   ?m=ar_aging&bucket=<key>[&party=<customer_id>][&as_of=YYYY-MM-DD]
// (one-shot — consumed on mount, and kept in sync while a drill is open so
// the URL is shareable).
//
// NOTE (Phase 2 fix): this panel previously read bucket_*_cents fields that
// neither API shape ever returned — every money cell rendered "—". It now
// pivots the view's long rows / the RPC's wide rows like InternalAPAging.

import { useEffect, useMemo, useState } from "react";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { useTablePrefs, TablePrefsButton, type ColumnDef } from "./components/TablePrefs";
import AgingDrillModal, { type AgingDrillTarget } from "./components/AgingDrillModal";
import { readDrillParam, consumeDrillParams } from "./scorecardDrill";
import {
  pivotViewRows, rpcRowsToPivot, sumBuckets, filterAgingRows, accountShortLabel,
  type ApiRow, type PivotRow, type AccountSummary,
} from "./arAgingHelpers";

// v2: bucket columns now match the SQL (91-120 and 120+ split; old key set
// had them lumped and never rendered) — bump so stale prefs reset.
const TABLE_KEY = "tanda.ar_aging.v2";
const ALL_COLUMNS: ColumnDef[] = [
  { key: "customer", label: "Customer" },
  { key: "current",  label: "Current" },
  { key: "b1_30",    label: "1-30" },
  { key: "b31_60",   label: "31-60" },
  { key: "b61_90",   label: "61-90" },
  { key: "b91_120",  label: "91-120" },
  { key: "b120plus", label: "120+" },
  { key: "total",    label: "Total Open" },
];

// Bucket keys AS THE API KNOWS THEM (ar-aging/detail ?bucket=).
const BUCKETS = [
  { key: "current", label: "Current",     col: "current" },
  { key: "1-30",    label: "1-30 days",   col: "b1_30" },
  { key: "31-60",   label: "31-60 days",  col: "b31_60" },
  { key: "61-90",   label: "61-90 days",  col: "b61_90" },
  { key: "91-120",  label: "91-120 days", col: "b91_120" },
  { key: "120+",    label: "120+ days",   col: "b120plus" },
] as const;

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

const BUCKET_COLOR: Record<string, string> = {
  current:  C.textSub,
  b1_30:    "#FACC15", // yellow
  b31_60:   "#FB923C", // orange
  b61_90:   "#F87171", // red
  b91_120:  "#EF4444", // deeper red
  b120plus: "#DC2626", // deepest red
};

const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
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
const tdNum: React.CSSProperties = {
  ...td, textAlign: "right", fontVariantNumeric: "tabular-nums",
};

function fmtCents(c: number | string | null | undefined): string {
  const n = Number(c ?? 0);
  if (!Number.isFinite(n) || n === 0) return "—";
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.trunc(abs / 100);
  const frac = abs - whole * 100;
  return `${neg ? "-" : ""}$${whole.toLocaleString()}.${String(frac).padStart(2, "0")}`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// Keep the URL shareable while a drill is open (replaceState — no history spam).
function syncDrillUrl(t: AgingDrillTarget | null): void {
  const url = new URL(window.location.href);
  for (const k of ["bucket", "party"]) url.searchParams.delete(k);
  if (t) {
    url.searchParams.set("bucket", t.bucket);
    if (t.partyId) url.searchParams.set("party", t.partyId);
  }
  window.history.replaceState(window.history.state, "", url.toString());
}

export default function InternalARAging() {
  const [pivot, setPivot] = useState<PivotRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [asOf, setAsOf] = useState<string>(() => readDrillParam("as_of") || todayISO());
  const [customerFilter, setCustomerFilter] = useState<string>("");
  const [mode, setMode] = useState<string>("current");
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [arAccount, setArAccount] = useState<string>(() => readDrillParam("ar_account") || "all");
  const [shopifyIds, setShopifyIds] = useState<string[]>([]);
  const [shopifyOpen, setShopifyOpen] = useState<{ open_cents: number; open_count: number }>({ open_cents: 0, open_count: 0 });
  const [excludeShopify, setExcludeShopify] = useState<boolean>(false);
  const [drill, setDrillState] = useState<AgingDrillTarget | null>(null);
  // One-shot deep link: ?bucket=<key>[&party=<customer_id>] opens the drill.
  const [pendingDeepLink, setPendingDeepLink] = useState<{ bucket: string; party: string } | null>(() => {
    const bucket = readDrillParam("bucket");
    if (!bucket) return null;
    return { bucket, party: readDrillParam("party") };
  });
  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(TABLE_KEY, ALL_COLUMNS);

  useEffect(() => { consumeDrillParams(["bucket", "party", "as_of", "ar_account"]); }, []);

  function setDrill(t: AgingDrillTarget | null) {
    setDrillState(t);
    syncDrillUrl(t);
  }

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      // Use as-of mode whenever the user has changed the date away from today.
      // Default-today still uses the cheaper v_ar_aging view.
      if (asOf && asOf !== todayISO()) params.set("as_of", asOf);
      if (arAccount && arAccount !== "all") params.set("ar_account", arAccount);
      const r = await fetch(`/api/internal/ar-aging?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const data = await r.json();
      setMode(data.mode || "current");
      const rows = (data.rows || []) as ApiRow[];
      setPivot(data.mode === "as_of" ? rpcRowsToPivot(rows) : pivotViewRows(rows));
      setAccounts((data.accounts || []) as AccountSummary[]);
      const sd = data.shopify_d2c || {};
      setShopifyIds((sd.customer_ids || []) as string[]);
      setShopifyOpen({ open_cents: Number(sd.open_cents || 0), open_count: Number(sd.open_count || 0) });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  // Reload on mount and whenever the AR-account filter changes (the date filter
  // reloads via the Refresh button, matching the existing behavior).
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [arAccount]);

  // Deep link fires once the grid has loaded (so party labels resolve).
  useEffect(() => {
    if (!pendingDeepLink || loading) return;
    const { bucket, party } = pendingDeepLink;
    setPendingDeepLink(null);
    const b = BUCKETS.find((x) => x.key === bucket) || (bucket === "total" ? { key: "total" as const, label: "Total Open" } : null);
    if (!b) return;
    const row = party ? pivot.find((r) => r.customer_id === party) : null;
    setDrill({
      kind: "ar",
      bucket: b.key,
      bucketLabel: b.label,
      asOf: asOf !== todayISO() ? asOf : null,
      partyId: party || null,
      partyLabel: row ? (row.customer_name || row.customer_code) : null,
      arAccountId: arAccount !== "all" ? arAccount : null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDeepLink, loading]);

  const shopifyIdSet = useMemo(() => new Set(shopifyIds), [shopifyIds]);
  const filtered = filterAgingRows(pivot, {
    customerText: customerFilter,
    excludeIds: excludeShopify ? shopifyIdSet : undefined,
  });

  const totals = sumBuckets(filtered);

  const drillAsOf = asOf !== todayISO() ? asOf : null;
  const drillArAccount = arAccount !== "all" ? arAccount : null;

  function openDrill(bucketKey: string, bucketLabel: string, row: PivotRow | null) {
    setDrill({
      kind: "ar",
      bucket: bucketKey,
      bucketLabel,
      asOf: drillAsOf,
      partyId: row ? row.customer_id : null,
      partyLabel: row ? (row.customer_name || row.customer_code) : null,
      arAccountId: drillArAccount,
    });
  }

  const clickableNum = (v: number): React.CSSProperties =>
    v !== 0 ? { cursor: "pointer", textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 3 } : {};

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>AR Aging</h2>
        <div style={{ fontSize: 11, color: C.textMuted }}>
          mode: <strong>{mode}</strong> · click any amount to see the invoices behind it
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          As of:
          <input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            style={{ ...inputStyle, width: 160 }}
          />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          AR account:
          <select
            value={arAccount}
            onChange={(e) => setArAccount(e.target.value)}
            style={{ ...inputStyle, width: 220 }}
            title="Split the aging by AR control account (House 1108 / Factored 1107 / Credit-card 1105)"
          >
            <option value="all">All AR accounts</option>
            {accounts.map((a) => (
              <option key={a.ar_account_id || "unmapped"} value={a.ar_account_id || "all"}>
                {accountShortLabel(a.code, a.name)}
              </option>
            ))}
          </select>
        </label>
        <input
          type="text"
          placeholder="Filter customer name or code…"
          value={customerFilter}
          onChange={(e) => setCustomerFilter(e.target.value)}
          style={{ ...inputStyle, maxWidth: 320 }}
        />
        {shopifyIds.length > 0 && (
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub, whiteSpace: "nowrap" }}
                 title="Shopify D2C ecom invoices are card-paid but their receipt was never applied — an unreconciled artifact, not real AR. Hide them for a clean house-wholesale view.">
            <input type="checkbox" checked={excludeShopify} onChange={(e) => setExcludeShopify(e.target.checked)} />
            Exclude Shopify D2C
          </label>
        )}
        <button onClick={() => void load()} style={btnSecondary}>Refresh</button>
        <ExportButton
          rows={(() => {
            const out: Array<Record<string, unknown>> = filtered.map((r) => ({ kind: "row", ...r }));
            out.push({ kind: "total", customer_code: "", customer_name: `TOTAL (${filtered.length})`, ...totals });
            return out;
          })()}
          filename={`ar-aging-${asOf}`}
          sheetName="AR Aging"
          columns={[
            { key: "kind",          header: "Kind" },
            { key: "customer_code", header: "Code" },
            { key: "customer_name", header: "Customer" },
            { key: "current",       header: "Current", format: "currency_cents" },
            { key: "b1_30",         header: "1-30",    format: "currency_cents" },
            { key: "b31_60",        header: "31-60",   format: "currency_cents" },
            { key: "b61_90",        header: "61-90",   format: "currency_cents" },
            { key: "b91_120",       header: "91-120",  format: "currency_cents" },
            { key: "b120plus",      header: "120+",    format: "currency_cents" },
            { key: "total",         header: "Total Open", format: "currency_cents" },
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

      {/* Per-account summary strip — the full House / Factored / CC split so the
          CEO sees at a glance that factored (Rosenthal's exposure) dwarfs the
          collectable house AR. Clicking a card filters the grid to that account. */}
      {accounts.length > 0 && (
        <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
          {accounts.map((a) => {
            const active = arAccount === (a.ar_account_id || "");
            return (
              <button
                key={a.ar_account_id || "unmapped"}
                onClick={() => setArAccount(active ? "all" : (a.ar_account_id || "all"))}
                style={{
                  flex: "1 1 180px", textAlign: "left", cursor: "pointer",
                  background: active ? "#0b1220" : C.card,
                  border: `1px solid ${active ? C.primary : C.cardBdr}`,
                  borderRadius: 10, padding: "10px 14px", color: C.text,
                }}
                title={`Show only ${accountShortLabel(a.code, a.name)} AR`}
              >
                <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  {accountShortLabel(a.code, a.name)}
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>{fmtCents(a.open_cents)}</div>
                <div style={{ fontSize: 11, color: C.textMuted }}>{a.open_count.toLocaleString()} open invoices</div>
              </button>
            );
          })}
          {shopifyOpen.open_cents > 0 && (
            <button
              onClick={() => setExcludeShopify((v) => !v)}
              style={{
                flex: "1 1 180px", textAlign: "left", cursor: "pointer",
                background: excludeShopify ? "#0b1220" : C.card,
                border: `1px solid ${excludeShopify ? C.warn : C.cardBdr}`,
                borderRadius: 10, padding: "10px 14px", color: C.text,
              }}
              title="Shopify D2C card-paid ecom invoices with no applied receipt — an unreconciled artifact inside house AR. Click to hide/show."
            >
              <div style={{ fontSize: 11, color: C.warn, textTransform: "uppercase", letterSpacing: 0.5 }}>
                Shopify D2C {excludeShopify ? "(hidden)" : "(likely unreconciled)"}
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2, color: C.warn }}>{fmtCents(shopifyOpen.open_cents)}</div>
              <div style={{ fontSize: 11, color: C.textMuted }}>{shopifyOpen.open_count.toLocaleString()} open invoices · click to {excludeShopify ? "show" : "exclude"}</div>
            </button>
          )}
        </div>
      )}

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          Error: {err}
        </div>
      )}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, maxHeight: "calc(100vh - 240px)", overflowY: "auto" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No customers with open AR.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th} hidden={!visibleColumns.has("customer")}>Customer</th>
                {BUCKETS.map((b) => (
                  <th key={b.col} style={{ ...th, textAlign: "right", color: BUCKET_COLOR[b.col] }} hidden={!visibleColumns.has(b.col)}>{b.label.replace(" days", "")}</th>
                ))}
                <th style={{ ...th, textAlign: "right" }} hidden={!visibleColumns.has("total")}>Total Open</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.customer_id}>
                  <td style={td} hidden={!visibleColumns.has("customer")}>
                    <strong>{r.customer_name || r.customer_code || "—"}</strong>
                    {r.customer_code && r.customer_name && (
                      <span style={{ color: C.textMuted, marginLeft: 6, fontSize: 11 }}>
                        ({r.customer_code})
                      </span>
                    )}
                    {shopifyIdSet.has(r.customer_id) && (
                      <span
                        style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: C.warn, border: `1px solid ${C.warn}`, borderRadius: 4, padding: "1px 5px", whiteSpace: "nowrap" }}
                        title="Shopify D2C — card-paid ecom, receipt not yet applied (likely unreconciled)"
                      >
                        D2C
                      </span>
                    )}
                  </td>
                  {BUCKETS.map((b) => {
                    const v = r[b.col as keyof PivotRow] as number;
                    return (
                      <td
                        key={b.col}
                        style={{ ...tdNum, color: v > 0 ? BUCKET_COLOR[b.col] : C.textMuted, ...clickableNum(v) }}
                        hidden={!visibleColumns.has(b.col)}
                        onClick={v !== 0 ? () => openDrill(b.key, b.label, r) : undefined}
                        title={v !== 0 ? "Show the open invoices behind this amount" : undefined}
                      >
                        {fmtCents(v)}
                      </td>
                    );
                  })}
                  <td
                    style={{ ...tdNum, fontWeight: 700, ...clickableNum(r.total) }}
                    hidden={!visibleColumns.has("total")}
                    onClick={r.total !== 0 ? () => openDrill("total", "Total Open", r) : undefined}
                    title={r.total !== 0 ? "Show all open invoices for this customer" : undefined}
                  >
                    {fmtCents(r.total)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: "#111827" }}>
                <td style={{ ...td, fontWeight: 700, color: C.textSub }} hidden={!visibleColumns.has("customer")}>TOTAL ({filtered.length})</td>
                {BUCKETS.map((b) => {
                  const v = totals[b.col as keyof typeof totals];
                  return (
                    <td
                      key={b.col}
                      style={{ ...tdNum, fontWeight: 700, color: BUCKET_COLOR[b.col], ...clickableNum(v) }}
                      hidden={!visibleColumns.has(b.col)}
                      onClick={v !== 0 ? () => openDrill(b.key, b.label, null) : undefined}
                      title={v !== 0 ? "Show all open invoices in this bucket" : undefined}
                    >
                      {fmtCents(v)}
                    </td>
                  );
                })}
                <td
                  style={{ ...tdNum, fontWeight: 700, ...clickableNum(totals.total) }}
                  hidden={!visibleColumns.has("total")}
                  onClick={totals.total !== 0 ? () => openDrill("total", "Total Open", null) : undefined}
                  title={totals.total !== 0 ? "Show every open invoice" : undefined}
                >
                  {fmtCents(totals.total)}
                </td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      {drill && <AgingDrillModal target={drill} onClose={() => setDrill(null)} />}
    </div>
  );
}
