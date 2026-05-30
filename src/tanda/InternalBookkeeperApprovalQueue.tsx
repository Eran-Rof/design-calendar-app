// src/tanda/InternalBookkeeperApprovalQueue.tsx
//
// Tangerine P13-3 — D19 Bookkeeper approval queue panel.
//
// Lists AP `invoices` rows WHERE is_receipt_rollup=true AND
// status='pending_bookkeeper_approval'. These are auto-created sibling AP
// invoices spawned by the receipt-rollup workflow. The bookkeeper
// approves each one, which (in P13-4) will flip status → 'approved' and
// invoke the P3 AP posting service.
//
// Per row: parent receipt link, vendor, GL account, amount, created_at.
// "Approve" → POST /api/internal/procurement/invoices/[id]/bookkeeper-approve.
//             That endpoint returns 501 in P13-3 (real impl ships P13-4).
// "Reject"  → PATCH invoices.status='rejected' with required reason.

import { useEffect, useMemo, useState } from "react";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";

export type RollupInvoice = {
  id: string;
  entity_id: string;
  vendor_id: string;
  invoice_number: string;
  invoice_kind: string;
  status: string;
  gl_status: string;
  posting_date: string;
  total_amount_cents: string;
  expense_account_id: string | null;
  description: string | null;
  is_receipt_rollup: boolean;
  rollup_parent_receipt_id: string | null;
  source: string | null;
  created_at: string;
  updated_at: string;
};

type Vendor = { id: string; name: string };
type Account = { id: string; code: string; name: string };

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
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", colorScheme: "dark",
};
const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13,
};

export function fmtCents(c: string | number | null | undefined): string {
  if (c === null || c === undefined || c === "") return "$0.00";
  let bi: bigint;
  try {
    bi = typeof c === "bigint" ? c : BigInt(String(c).replace(/[^-0-9]/g, "") || "0");
  } catch {
    return "$0.00";
  }
  const neg = bi < 0n;
  const abs = neg ? -bi : bi;
  const whole = (abs / 100n).toString();
  const frac = (abs % 100n).toString().padStart(2, "0");
  const w = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${w}.${frac}`;
}

export function statusColor(s: string): string {
  if (s === "pending_bookkeeper_approval") return C.warn;
  if (s === "approved") return C.success;
  if (s === "rejected") return C.danger;
  return C.textMuted;
}

export default function InternalBookkeeperApprovalQueue() {
  const [rows, setRows] = useState<RollupInvoice[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [includeHistory, setIncludeHistory] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (includeHistory) params.set("include_history", "true");
      const r = await fetch(`/api/internal/procurement/bookkeeper-queue?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as RollupInvoice[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [includeHistory]);

  useEffect(() => {
    fetch("/api/internal/vendors?limit=1000")
      .then((r) => r.json())
      .then((arr: unknown) => { if (Array.isArray(arr)) setVendors(arr as Vendor[]); })
      .catch(() => {});
    fetch("/api/internal/gl-accounts?limit=1000")
      .then((r) => r.json())
      .then((arr: unknown) => { if (Array.isArray(arr)) setAccounts(arr as Account[]); })
      .catch(() => {});
  }, []);

  const vendorMap = useMemo(() => {
    const m: Record<string, Vendor> = {};
    for (const v of vendors) m[v.id] = v;
    return m;
  }, [vendors]);

  const accountMap = useMemo(() => {
    const m: Record<string, Account> = {};
    for (const a of accounts) m[a.id] = a;
    return m;
  }, [accounts]);

  async function approve(inv: RollupInvoice) {
    if (!confirm(`Approve ${inv.invoice_number} (${fmtCents(inv.total_amount_cents)})?`)) return;
    setBusy(inv.id);
    try {
      const r = await fetch(`/api/internal/procurement/invoices/${inv.id}/bookkeeper-approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 501) {
        alert(`Bookkeeper approval ships in P13-4. Stub returned 501.\n\n${j.detail || ""}`);
        return;
      }
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await load();
    } catch (e: unknown) {
      alert(`Approve failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function reject(inv: RollupInvoice) {
    const reason = prompt(`Reject ${inv.invoice_number}? Reason (required):`, "");
    if (reason === null || !reason.trim()) {
      if (reason !== null) alert("Reason is required.");
      return;
    }
    setBusy(inv.id);
    try {
      // Use the existing ap-invoices PATCH surface to flip status; the field
      // is not under [id]'s normal patch list, so we send through a dedicated
      // body keyed at 'status'. If that surface doesn't accept it (current
      // [id].js locks gl_status edits), the bookkeeper queue panel surfaces a
      // useful error so the operator knows to wait for P13-4.
      const r = await fetch(`/api/internal/ap-invoices/${inv.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "rejected", description: `Bookkeeper rejected: ${reason.trim()}` }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}. Rejection flow is finalised in P13-4.`);
      }
      await load();
    } catch (e: unknown) {
      alert(`Reject failed: ${e instanceof Error ? e.message : String(e)}\n\nNote: full reject flow ships in P13-4.`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>📦 Procurement — Bookkeeper Approval Queue</h2>
        <div style={{ fontSize: 11, color: C.textMuted }}>
          D19 receipt-rollup AP invoices · {rows.length} in queue
        </div>
      </div>

      <div style={{ marginBottom: 12, padding: 12, background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, fontSize: 12, color: C.textSub }}>
        These are AP invoices auto-spawned by the D19 receipt-rollup workflow.
        Each row needs bookkeeper approval before the P3 AP posting service runs.
        The Approve handler is a stub (h499) in P13-3 — P13-4 lands the real
        approval flow that flips status and posts the JE.
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input type="checkbox" checked={includeHistory} onChange={(e) => setIncludeHistory(e.target.checked)} />
          Include approved + rejected history
        </label>
        <button onClick={() => void load()} style={btnSecondary}>Refresh</button>
        <ExportButton
          rows={rows.map((inv) => ({
            invoice_number: inv.invoice_number,
            parent_receipt_id: inv.rollup_parent_receipt_id,
            vendor: vendorMap[inv.vendor_id]?.name || inv.vendor_id,
            expense_account: accountMap[inv.expense_account_id || ""] ? `${accountMap[inv.expense_account_id || ""].code} — ${accountMap[inv.expense_account_id || ""].name}` : inv.expense_account_id,
            amount_cents: inv.total_amount_cents,
            status: inv.status,
            created_at: inv.created_at,
            description: inv.description,
          })) as unknown as Array<Record<string, unknown>>}
          filename="bookkeeper-approval-queue"
          sheetName="Rollup AP Invoices"
          columns={[
            { key: "invoice_number",     header: "Invoice #" },
            { key: "parent_receipt_id",  header: "Parent receipt" },
            { key: "vendor",             header: "Vendor" },
            { key: "expense_account",    header: "GL account" },
            { key: "amount_cents",       header: "Amount", format: "currency_cents" },
            { key: "status",             header: "Status" },
            { key: "created_at",         header: "Created at", format: "date" },
            { key: "description",        header: "Description" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          Error: {err}
        </div>
      )}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
            No rollup AP invoices waiting on bookkeeper approval.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 220 }}>Invoice #</th>
                <th style={th}>Parent receipt</th>
                <th style={th}>Vendor</th>
                <th style={th}>Expense GL</th>
                <th style={{ ...th, textAlign: "right" }}>Amount</th>
                <th style={th}>Created at</th>
                <th style={th}>Status</th>
                <th style={{ ...th, width: 200, textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((inv) => {
                const acct = accountMap[inv.expense_account_id || ""];
                const pending = inv.status === "pending_bookkeeper_approval";
                return (
                  <tr key={inv.id}>
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }}>{inv.invoice_number}</td>
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 11 }}>
                      {inv.rollup_parent_receipt_id ? inv.rollup_parent_receipt_id.slice(0, 12) + "…" : ""}
                    </td>
                    <td style={td}>{vendorMap[inv.vendor_id]?.name || inv.vendor_id.slice(0, 8)}</td>
                    <td style={td}>
                      {acct ? `${acct.code} — ${acct.name}` : (inv.expense_account_id || "—")}
                    </td>
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", textAlign: "right" }}>
                      {fmtCents(inv.total_amount_cents)}
                    </td>
                    <td style={td}>{inv.created_at?.slice(0, 10)}</td>
                    <td style={td}>
                      <span style={{ color: statusColor(inv.status), fontWeight: 600 }}>● {inv.status}</span>
                    </td>
                    <td style={{ ...td, textAlign: "right" }}>
                      {pending && (
                        <>
                          <button onClick={() => void approve(inv)} style={btnSuccess} disabled={busy === inv.id}>Approve</button>
                          <button onClick={() => void reject(inv)} style={{ ...btnDanger, marginLeft: 6 }} disabled={busy === inv.id}>Reject</button>
                        </>
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
