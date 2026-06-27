// src/tanda/InternalBookkeeperApproval.tsx
//
// Tangerine P13 — Bookkeeper Approval Queue.
//
// Lists the AP "rollup" invoices (freight / duty / broker) that P13 receiving
// auto-creates with status='pending_bookkeeper_approval'. A bookkeeper reviews
// each, then Approves (→ posts the AP journal entry) or Rejects (with a reason).
//
// List endpoint:   GET  /api/internal/procurement/bookkeeper-queue
// Approve/Reject:  POST /api/internal/procurement/bookkeeper-queue/{id}
//                       body { action: "approve" }  | { action: "reject", reason }
// (the POST endpoints are owned by the sibling [id].js handler.)

import { useEffect, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";

type RollupInvoice = {
  id: string;
  entity_id: string;
  vendor_id: string | null;
  invoice_number: string;
  invoice_date: string | null;
  due_date: string | null;
  status: string;
  gl_status: string;
  total_amount_cents: string | number | null;
  currency: string | null;
  source: string | null;
  description: string | null;
  is_receipt_rollup: boolean;
  rollup_parent_receipt_id: string | null;
  created_at: string;
  vendor: { id: string; name: string } | null;
};

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "8px 14px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const btnDanger: React.CSSProperties = { ...btnSecondary, color: C.danger, borderColor: "#7f1d1d" };
const btnSuccess: React.CSSProperties = { ...btnSecondary, color: C.success, borderColor: "#065f46" };

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

function fmtCents(c: string | number | null | undefined): string {
  if (c == null) return "$0.00";
  const n = typeof c === "number" ? c : Number(String(c).replace(/[^-0-9.]/g, "") || "0");
  if (!Number.isFinite(n)) return "$0.00";
  return `$${(n / 100).toFixed(2)}`;
}

export default function InternalBookkeeperApproval() {
  const [rows, setRows] = useState<RollupInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Reject reason modal state.
  const [rejecting, setRejecting] = useState<RollupInvoice | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/api/internal/procurement/bookkeeper-queue");
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as RollupInvoice[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function doApprove(inv: RollupInvoice) {
    if (!(await confirmDialog(`Approve invoice ${inv.invoice_number}? It will be released to AP for posting.`))) return;
    setBusy(inv.id);
    try {
      const r = await fetch(`/api/internal/procurement/bookkeeper-queue/${inv.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      notify(j.message || "Approved & posted", "success");
      await load();
    } catch (e: unknown) {
      notify(`Approve failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(null);
    }
  }

  function openReject(inv: RollupInvoice) {
    setRejecting(inv);
    setRejectReason("");
  }

  async function submitReject() {
    const inv = rejecting;
    if (!inv) return;
    const reason = rejectReason.trim();
    if (!reason) { notify("A rejection reason is required.", "error"); return; }
    setBusy(inv.id);
    try {
      const r = await fetch(`/api/internal/procurement/bookkeeper-queue/${inv.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject", reason }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      notify(j.message || "Rejected", "success");
      setRejecting(null);
      setRejectReason("");
      await load();
    } catch (e: unknown) {
      notify(`Reject failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Bookkeeper Approval</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => void load()} style={btnSecondary} disabled={loading}>Refresh</button>
          <ExportButton
            rows={rows.map((inv) => ({
              invoice_number: inv.invoice_number,
              vendor: inv.vendor?.name || inv.vendor_id || "—",
              invoice_date: inv.invoice_date,
              total_amount_cents: inv.total_amount_cents,
              source: inv.source || "system",
              rollup_parent_receipt_id: inv.rollup_parent_receipt_id,
              description: inv.description,
            })) as unknown as Array<Record<string, unknown>>}
            filename="bookkeeper-approval-queue"
            sheetName="Approval Queue"
            columns={[
              { key: "invoice_number",           header: "Invoice #" },
              { key: "vendor",                   header: "Vendor" },
              { key: "invoice_date",             header: "Date", format: "date" },
              { key: "total_amount_cents",       header: "Amount", format: "currency_cents" },
              { key: "source",                   header: "Source" },
              { key: "rollup_parent_receipt_id", header: "Receipt" },
              { key: "description",              header: "Description" },
            ] as ExportColumn<Record<string, unknown>>[]}
          />
        </div>
      </div>

      <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 16 }}>
        Rollup AP invoices (freight / duty / broker) from receiving are held here until you approve them. Approving releases the invoice to AP, where it posts to the GL via the normal AP posting flow.
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
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No invoices awaiting approval.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 150 }}>Invoice #</th>
                <th style={th}>Vendor</th>
                <th style={th}>Date</th>
                <th style={{ ...th, textAlign: "right" }}>Amount</th>
                <th style={th}>Receipt</th>
                <th style={th}>Source</th>
                <th style={{ ...th, width: 200, textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((inv) => (
                <tr key={inv.id}>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }}>{inv.invoice_number}</td>
                  <td style={td}>{inv.vendor?.name || "—"}</td>
                  <td style={td}>{inv.invoice_date || "—"}</td>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", textAlign: "right" }}>
                    {fmtCents(inv.total_amount_cents)}
                  </td>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 11, color: C.textMuted }}>
                    {inv.rollup_parent_receipt_id || "—"}
                  </td>
                  <td style={td}>{inv.source || "system"}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button
                      onClick={() => void doApprove(inv)}
                      style={btnSuccess}
                      disabled={busy === inv.id}
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => openReject(inv)}
                      style={{ ...btnDanger, marginLeft: 6 }}
                      disabled={busy === inv.id}
                    >
                      Reject
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {rejecting && (
        <div
          onClick={() => { if (busy !== rejecting.id) setRejecting(null); }}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
            display: "flex", alignItems: "flex-start", justifyContent: "center",
            zIndex: 100, paddingTop: 80,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10,
              padding: 20, width: "min(460px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text,
            }}
          >
            <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>
              Reject invoice {rejecting.invoice_number}
            </h3>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 6 }}>
              A reason is required and will be recorded on the invoice.
            </div>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Reason for rejection…"
              rows={3}
              style={{ ...inputStyle, resize: "vertical" }}
              autoFocus
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
              <button
                onClick={() => setRejecting(null)}
                style={btnSecondary}
                disabled={busy === rejecting.id}
              >
                Cancel
              </button>
              <button
                onClick={() => void submitReject()}
                style={{ ...btnPrimary, background: C.danger }}
                disabled={busy === rejecting.id || !rejectReason.trim()}
              >
                {busy === rejecting.id ? "Rejecting…" : "Reject invoice"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
