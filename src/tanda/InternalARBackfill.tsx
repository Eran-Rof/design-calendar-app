// src/tanda/InternalARBackfill.tsx
//
// Tangerine P4-8 — AR historical backfill admin panel.
//
// Operator workflow:
//   1. Run a DRY RUN over the desired window to preview counts.
//   2. If counts look right, uncheck dry_run and re-run.
//   3. Inspect the checkpoint log + reconciliation rows below.
//   4. If a month shows variance, investigate via the bf_skipped_cogs_log
//      and bf_unmatched_customers_log audits.

import { useEffect, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import DateRangePresets from "./components/DateRangePresets.tsx";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

type CheckpointRow = {
  id: string;
  backfill_run_id: string;
  year: number;
  month: number;
  invoices_created: number;
  je_created: number;
  status: string;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

type UnmatchedRow = {
  id: string;
  source_customer_code: string | null;
  source_customer_name: string | null;
  invoice_number: string | null;
  resolution: string;
  resolved_customer_id: string | null;
  notes: string | null;
  logged_at: string;
};

type SkippedRow = {
  id: string;
  invoice_number: string | null;
  source_line_key: string | null;
  sku_id: string | null;
  reason: string;
  logged_at: string;
};

type ReconRow = {
  year: number | null;
  month: number | null;
  source_invoice_count: number | null;
  ar_invoice_count: number | null;
  source_revenue: number | null;
  ar_revenue: number | null;
  variance: number | null;
  variance_pct: number | null;
};

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "8px 14px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
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
  textAlign: "left", padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
  position: "sticky", top: 0, zIndex: 2,
};
const td: React.CSSProperties = {
  padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 12,
};

function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function InternalARBackfill() {
  const [startDate, setStartDate] = useState("2024-08-01");
  const [endDate, setEndDate] = useState(new Date().toISOString().slice(0, 10));
  const [dryRun, setDryRun] = useState(true);
  const [running, setRunning] = useState(false);
  const [runErr, setRunErr] = useState<string | null>(null);
  const [lastSummary, setLastSummary] = useState<Record<string, unknown> | null>(null);

  const [checkpoints, setCheckpoints] = useState<CheckpointRow[]>([]);
  const [unmatched, setUnmatched] = useState<UnmatchedRow[]>([]);
  const [skipped, setSkipped] = useState<SkippedRow[]>([]);
  const [recon, setRecon] = useState<ReconRow[]>([]);
  // Resolve skipped-line sku_id → human sku_code (no raw UUIDs in the table).
  const [skuById, setSkuById] = useState<Record<string, string>>({});

  async function loadStatus() {
    try {
      const r = await fetch(`/api/internal/ar-backfill/status`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const data = await r.json();
      setCheckpoints(data.checkpoint_log || []);
      setUnmatched(data.unmatched_customers || []);
      setSkipped(data.skipped_cogs || []);
      setRecon(data.reconciliation || []);
    } catch (e: unknown) {
      console.error("backfill status load failed", e);
    }
  }

  useEffect(() => { void loadStatus(); }, []);

  // Resolve the sku ids present in the skipped-COGS log to sku_code labels.
  useEffect(() => {
    const ids = Array.from(new Set(skipped.map((r) => r.sku_id).filter((v): v is string => !!v)))
      .filter((id) => !(id in skuById));
    if (ids.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/internal/items?ids=${encodeURIComponent(ids.join(","))}`);
        if (!r.ok) return;
        const data = (await r.json()) as Array<{ id: string; sku_code: string | null }>;
        if (cancelled) return;
        setSkuById((prev) => {
          const next = { ...prev };
          for (const it of data) next[it.id] = it.sku_code || "—";
          return next;
        });
      } catch { /* leave as "—" */ }
    })();
    return () => { cancelled = true; };
  }, [skipped]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run() {
    if (!dryRun) {
      const proceed = await confirmDialog(
        `LIVE RUN: this will create ar_invoices + journal_entries for every invoice in ip_sales_history_wholesale ` +
        `between ${startDate} and ${endDate} for entity ROF. Re-runs are idempotent (skipped on conflict). Continue?`,
      );
      if (!proceed) return;
    }
    setRunning(true);
    setRunErr(null);
    setLastSummary(null);
    try {
      const r = await fetch(`/api/internal/ar-backfill/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: startDate, end_date: endDate, dry_run: dryRun }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setLastSummary(data);
      await loadStatus();
    } catch (e: unknown) {
      setRunErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ color: C.text }}>
      <h2 style={{ margin: "0 0 16px", fontSize: 22 }}>AR Historical Backfill</h2>

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 16, marginBottom: 20 }}>
        <div style={{ fontSize: 13, color: C.textSub, marginBottom: 12 }}>
          Loops <code>ip_sales_history_wholesale</code> month-by-month and writes
          historical <code>ar_invoices</code> + <code>journal_entries</code>
          using <code>journal_type='ar_invoice_historical'</code> (the trigger
          bypasses period locks for that journal type). FIFO is NOT touched —
          COGS comes from <code>unit_cost_at_sale</code> directly.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 12, alignItems: "end" }}>
          <div>
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase" }}>Start date</div>
            <input type="date" value={startDate} min="2024-08-01" onChange={(e) => setStartDate(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase" }}>End date</div>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={inputStyle} />
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: C.textSub }}>
              <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
              Dry run
            </label>
            <button onClick={() => void run()} style={btnPrimary} disabled={running}>
              {running ? "Running…" : dryRun ? "Preview" : "Run backfill"}
            </button>
            <button onClick={() => void loadStatus()} style={btnSecondary} disabled={running}>Refresh</button>
          </div>
        </div>
        <div style={{ marginTop: 8 }}>
          <DateRangePresets variant="dropdown"
            from={startDate}
            to={endDate}
            onChange={(f, t) => { setStartDate(f); setEndDate(t); }}
          />
        </div>

        {runErr && (
          <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 12 }}>
            Error: {runErr}
          </div>
        )}
        {lastSummary && (
          <div style={{ background: "#0b1220", padding: 12, borderRadius: 6, marginTop: 12, fontSize: 12, color: C.textSub, fontFamily: "monospace", whiteSpace: "pre-wrap" }}>
            {JSON.stringify(lastSummary, null, 2)}
          </div>
        )}
      </div>

      <Section
        title={`Checkpoint log (${checkpoints.length})`}
        action={
          <ExportButton
            rows={checkpoints as unknown as Array<Record<string, unknown>>}
            filename="ar-backfill-checkpoints"
            sheetName="Checkpoints"
            columns={[
              { key: "backfill_run_id",   header: "Run ID" },
              { key: "year",              header: "Year" },
              { key: "month",             header: "Month" },
              { key: "invoices_created",  header: "Invoices", format: "number" },
              { key: "je_created",        header: "JEs",      format: "number" },
              { key: "status",            header: "Status" },
              { key: "started_at",        header: "Started",  format: "datetime" },
              { key: "finished_at",       header: "Finished", format: "datetime" },
              { key: "error",             header: "Error" },
            ] as ExportColumn<Record<string, unknown>>[]}
          />
        }
      >
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th style={th}>Run</th><th style={th}>Year</th><th style={th}>Month</th>
            <th style={{ ...th, textAlign: "right" }}>Invoices</th>
            <th style={{ ...th, textAlign: "right" }}>JEs</th>
            <th style={th}>Status</th><th style={th}>Started</th><th style={th}>Error</th>
          </tr></thead>
          <tbody>
            {checkpoints.map((r) => (
              <tr key={r.id}>
                <td style={{ ...td, fontSize: 10 }}>{"—"}</td>
                <td style={td}>{r.year}</td>
                <td style={td}>{String(r.month).padStart(2, "0")}</td>
                <td style={{ ...td, textAlign: "right" }}>{r.invoices_created}</td>
                <td style={{ ...td, textAlign: "right" }}>{r.je_created}</td>
                <td style={{ ...td, color: r.status === "failed" ? C.danger : r.status === "done" ? C.success : C.textSub }}>{r.status}</td>
                <td style={{ ...td, fontSize: 10, color: C.textMuted }}>{new Date(r.started_at).toLocaleString()}</td>
                <td style={{ ...td, color: C.danger, fontSize: 10 }}>{r.error || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section
        title={`Reconciliation — variance rows only (${recon.filter((r) => Number(r.variance) !== 0).length})`}
        action={
          <ExportButton
            rows={recon.filter((r) => Number(r.variance ?? 0) !== 0) as unknown as Array<Record<string, unknown>>}
            filename="ar-backfill-reconciliation"
            sheetName="Reconciliation"
            columns={[
              { key: "year",                  header: "Year" },
              { key: "month",                 header: "Month" },
              { key: "source_invoice_count",  header: "Src #",   format: "number" },
              { key: "ar_invoice_count",      header: "AR #",    format: "number" },
              { key: "source_revenue",        header: "Src $",   format: "currency_dollars" },
              { key: "ar_revenue",            header: "AR $",    format: "currency_dollars" },
              { key: "variance",              header: "Variance", format: "currency_dollars" },
              { key: "variance_pct",          header: "Variance %", format: "percent" },
            ] as ExportColumn<Record<string, unknown>>[]}
          />
        }
      >
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th style={th}>Year</th><th style={th}>Month</th>
            <th style={{ ...th, textAlign: "right" }}>Src #</th>
            <th style={{ ...th, textAlign: "right" }}>AR #</th>
            <th style={{ ...th, textAlign: "right" }}>Src $</th>
            <th style={{ ...th, textAlign: "right" }}>AR $</th>
            <th style={{ ...th, textAlign: "right" }}>Variance</th>
          </tr></thead>
          <tbody>
            {recon.filter((r) => Number(r.variance ?? 0) !== 0).map((r, i) => (
              <tr key={i}>
                <td style={td}>{r.year ?? "—"}</td>
                <td style={td}>{r.month != null ? String(r.month).padStart(2, "0") : "—"}</td>
                <td style={{ ...td, textAlign: "right" }}>{r.source_invoice_count ?? "—"}</td>
                <td style={{ ...td, textAlign: "right" }}>{r.ar_invoice_count ?? "—"}</td>
                <td style={{ ...td, textAlign: "right" }}>{fmtMoney(r.source_revenue)}</td>
                <td style={{ ...td, textAlign: "right" }}>{fmtMoney(r.ar_revenue)}</td>
                <td style={{ ...td, textAlign: "right", color: Math.abs(Number(r.variance ?? 0)) > 0.5 ? C.warn : C.textSub }}>{fmtMoney(r.variance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section
        title={`Unmatched / synthesized customers (${unmatched.length})`}
        action={
          <ExportButton
            rows={unmatched as unknown as Array<Record<string, unknown>>}
            filename="ar-backfill-unmatched-customers"
            sheetName="Unmatched"
            columns={[
              { key: "source_customer_code", header: "Code" },
              { key: "source_customer_name", header: "Name" },
              { key: "invoice_number",       header: "Invoice" },
              { key: "resolution",           header: "Resolution" },
              { key: "resolved_customer_id", header: "Resolved Customer ID" },
              { key: "notes",                header: "Notes" },
              { key: "logged_at",            header: "Logged At", format: "datetime" },
            ] as ExportColumn<Record<string, unknown>>[]}
          />
        }
      >
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th style={th}>Code</th><th style={th}>Name</th><th style={th}>Invoice</th><th style={th}>Resolution</th><th style={th}>Notes</th>
          </tr></thead>
          <tbody>
            {unmatched.map((r) => (
              <tr key={r.id}>
                <td style={td}>{r.source_customer_code || "—"}</td>
                <td style={td}>{r.source_customer_name || "—"}</td>
                <td style={td}>{r.invoice_number || "—"}</td>
                <td style={{ ...td, color: r.resolution === "synthesized" ? C.warn : r.resolution === "skipped" ? C.danger : C.textSub }}>{r.resolution}</td>
                <td style={{ ...td, color: C.textMuted, fontSize: 11 }}>{r.notes || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section
        title={`Skipped COGS lines (${skipped.length})`}
        action={
          <ExportButton
            rows={skipped as unknown as Array<Record<string, unknown>>}
            filename="ar-backfill-skipped-cogs"
            sheetName="Skipped COGS"
            columns={[
              { key: "invoice_number",   header: "Invoice" },
              { key: "source_line_key",  header: "Line Key" },
              { key: "sku_id",           header: "SKU ID" },
              { key: "reason",           header: "Reason" },
              { key: "logged_at",        header: "Logged At", format: "datetime" },
            ] as ExportColumn<Record<string, unknown>>[]}
          />
        }
      >
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th style={th}>Invoice</th><th style={th}>Line key</th><th style={th}>SKU</th><th style={th}>Reason</th>
          </tr></thead>
          <tbody>
            {skipped.map((r) => (
              <tr key={r.id}>
                <td style={td}>{r.invoice_number || "—"}</td>
                <td style={{ ...td, fontFamily: "monospace", fontSize: 10 }}>{r.source_line_key || "—"}</td>
                <td style={{ ...td, fontSize: 11 }}>{r.sku_id ? (skuById[r.sku_id] || "—") : "—"}</td>
                <td style={{ ...td, color: C.warn }}>{r.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.textSub }}>{title}</div>
        {action}
      </div>
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, maxHeight: 320, overflowY: "auto" }}>
        {children}
      </div>
    </div>
  );
}
