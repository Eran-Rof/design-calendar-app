// src/tanda/InternalReceiving.tsx
//
// Tangerine P13-3 — M38 Procurement receiving panel.
//
// Lists tanda_po_receipts in status IN (draft, pending_approval, approved).
// "+ New receipt" opens a modal that captures the source PO (SearchableSelect
// filtered to procurement_status IN (open, approved)), receipt date,
// receiving-employee, and a lines grid pre-populated from po_line_items
// (qty_received / qty_accepted / qty_rejected / unit_cost_cents).
//
// D19 rollup section — operator adds N rollup lines (expense GL account /
// amount / vendor / description / capitalize-to-inventory). On save, POST
// /api/internal/procurement/receipts/[id]/save-rollups replaces the rollups
// and auto-creates one AP invoice per rollup in
// status='pending_bookkeeper_approval' (D19 gate).
//
// Cross-cutters: DateRangePresets (T7), SearchableSelect (T9),
// ExportButton (T3/T8).

import { useEffect, useMemo, useState } from "react";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import SearchableSelect from "./components/SearchableSelect";
import DateRangePresets from "./components/DateRangePresets.tsx";

export type ReceiptStatus = "draft" | "pending_approval" | "approved" | "posted";

export type ReceiptRow = {
  id: string;
  entity_id: string;
  tanda_po_id: string;
  receipt_date: string;
  received_by_employee_id: string | null;
  status: ReceiptStatus;
  landed_cost_cents: string;
  notes: string | null;
  je_id: string | null;
  created_at: string;
  updated_at: string;
};

export type ReceiptLine = {
  id?: string;
  receipt_id?: string;
  po_line_item_id: string;
  qty_received: number;
  qty_accepted: number;
  qty_rejected: number;
  unit_cost_cents: string;
  landed_unit_cost_cents: string | null;
  inventory_location_id: string | null;
};

export type Rollup = {
  id?: string;
  receipt_id?: string;
  expense_gl_account_id: string;
  amount_cents: string;
  vendor_id: string | null;
  description: string;
  capitalized_to_inventory: boolean;
  auto_invoice_id?: string | null;
  created_at?: string;
};

export type ReceiptFull = ReceiptRow & { lines: ReceiptLine[]; rollups: Rollup[] };

type PoOption = {
  id: string;
  po_number: string;
  vendor: string;
  vendor_id: string | null;
  procurement_status: string | null;
  pilot_vendor_flag: boolean;
};

type Vendor = { id: string; name: string };

type Account = {
  id: string;
  code: string;
  name: string;
  account_type: string;
  is_postable: boolean;
  status: string;
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

export function dollarsToCents(s: string): bigint | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!/^-?\d{1,12}(\.\d{1,2})?$/.test(trimmed)) return null;
  const neg = trimmed.startsWith("-");
  const u = neg ? trimmed.slice(1) : trimmed;
  const [whole, frac = ""] = u.split(".");
  const padded = (frac + "00").slice(0, 2);
  const cents = BigInt(whole) * 100n + BigInt(padded);
  return neg ? -cents : cents;
}

export const RECEIPT_STATUS_OPTIONS: { value: ReceiptStatus | ""; label: string }[] = [
  { value: "",                 label: "All active statuses" },
  { value: "draft",            label: "Draft" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "approved",         label: "Approved" },
  { value: "posted",           label: "Posted" },
];

export function statusColor(s: ReceiptStatus): string {
  if (s === "approved") return C.success;
  if (s === "pending_approval") return C.warn;
  if (s === "posted") return C.primary;
  return C.textMuted;
}

export const ALLOWED_TRANSITIONS: Record<ReceiptStatus, ReceiptStatus[]> = {
  draft:            ["pending_approval"],
  pending_approval: ["approved", "draft"],
  approved:         ["posted"],
  posted:           [],
};

export default function InternalReceiving() {
  const [rows, setRows] = useState<ReceiptRow[]>([]);
  const [pos, setPos] = useState<PoOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<ReceiptStatus | "">("");
  const [poFilter, setPoFilter] = useState<string>("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [includePosted, setIncludePosted] = useState(false);
  const [limit, setLimit] = useState(200);

  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<ReceiptRow | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams({ limit: String(limit) });
      if (statusFilter) params.set("status", statusFilter);
      if (poFilter) params.set("po_id", poFilter);
      if (fromDate) params.set("from", fromDate);
      if (toDate) params.set("to", toDate);
      if (includePosted) params.set("include_posted", "true");
      const r = await fetch(`/api/internal/procurement/receipts?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as ReceiptRow[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [statusFilter, poFilter, includePosted, fromDate, toDate, limit]);

  useEffect(() => {
    fetch("/api/internal/procurement/pos?limit=500&include_terminal=true")
      .then((r) => r.json())
      .then((arr: unknown) => { if (Array.isArray(arr)) setPos(arr as PoOption[]); })
      .catch(() => {});
  }, []);

  const poMap = useMemo(() => {
    const m: Record<string, PoOption> = {};
    for (const p of pos) m[p.id] = p;
    return m;
  }, [pos]);

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>📦 Procurement — Receiving</h2>
        <button onClick={() => { setEditing(null); setEditOpen(true); }} style={btnPrimary}>
          + New receipt
        </button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as ReceiptStatus | "")} style={{ ...inputStyle, width: 200 }}>
          {RECEIPT_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <div style={{ width: 280 }}>
          <SearchableSelect
            value={poFilter || null}
            onChange={(v) => setPoFilter(v)}
            options={[{ value: "", label: "All POs" }, ...pos.map((p) => ({ value: p.id, label: `${p.po_number} — ${p.vendor}` }))]}
            placeholder="All POs"
          />
        </div>
        <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={{ ...inputStyle, width: 140 }} />
        <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={{ ...inputStyle, width: 140 }} />
        <DateRangePresets from={fromDate} to={toDate} onChange={(f, t) => { setFromDate(f); setToDate(t); }} />
        <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} style={{ ...inputStyle, width: 110 }}>
          <option value={50}>Limit 50</option>
          <option value={100}>Limit 100</option>
          <option value={200}>Limit 200</option>
          <option value={500}>Limit 500</option>
        </select>
        <button onClick={() => void load()} style={btnSecondary}>Search</button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input type="checkbox" checked={includePosted} onChange={(e) => setIncludePosted(e.target.checked)} />
          Include posted
        </label>
        <ExportButton
          rows={rows.map((r) => ({
            receipt_id: r.id,
            po: poMap[r.tanda_po_id]?.po_number || r.tanda_po_id.slice(0, 8),
            vendor: poMap[r.tanda_po_id]?.vendor || "",
            receipt_date: r.receipt_date,
            status: r.status,
            landed_cost_cents: r.landed_cost_cents,
            notes: r.notes,
          })) as unknown as Array<Record<string, unknown>>}
          filename="procurement-receipts"
          sheetName="Procurement Receipts"
          columns={[
            { key: "receipt_id",        header: "Receipt ID" },
            { key: "po",                header: "PO #" },
            { key: "vendor",            header: "Vendor" },
            { key: "receipt_date",      header: "Receipt Date", format: "date" },
            { key: "status",            header: "Status" },
            { key: "landed_cost_cents", header: "Landed Rollups", format: "currency_cents" },
            { key: "notes",             header: "Notes" },
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
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No receipts.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 200 }}>Receipt ID</th>
                <th style={th}>PO #</th>
                <th style={th}>Vendor</th>
                <th style={th}>Receipt Date</th>
                <th style={th}>Status</th>
                <th style={{ ...th, textAlign: "right" }}>Landed Rollups</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} onClick={() => { setEditing(r); setEditOpen(true); }} style={{ cursor: "pointer" }}>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }}>{r.id.slice(0, 12)}…</td>
                  <td style={td}>{poMap[r.tanda_po_id]?.po_number || r.tanda_po_id.slice(0, 8)}</td>
                  <td style={td}>{poMap[r.tanda_po_id]?.vendor || ""}</td>
                  <td style={td}>{r.receipt_date}</td>
                  <td style={td}>
                    <span style={{ color: statusColor(r.status), fontWeight: 600 }}>● {r.status}</span>
                  </td>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", textAlign: "right" }}>
                    {fmtCents(r.landed_cost_cents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editOpen && (
        <ReceiptModal
          receipt={editing}
          pos={pos.filter((p) => p.procurement_status === "open" || p.procurement_status === "approved" || (editing && p.id === editing.tanda_po_id))}
          onClose={() => { setEditOpen(false); setEditing(null); }}
          onSaved={() => { setEditOpen(false); setEditing(null); void load(); }}
        />
      )}

      <div style={{ marginTop: 16, padding: 12, background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, fontSize: 11, color: C.textMuted }}>
        Audit log surfaces here once T11-3 RowHistory drop-in ships.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Receipt modal — supports new + edit + rollup workflow
// ─────────────────────────────────────────────────────────────────────

type DraftLine = {
  key: number;
  po_line_item_id: string;
  description: string;
  qty_received: string;
  qty_accepted: string;
  qty_rejected: string;
  unit_cost_dollars: string;
};

type DraftRollup = {
  key: number;
  expense_gl_account_id: string;
  amount_dollars: string;
  vendor_id: string;
  description: string;
  capitalized_to_inventory: boolean;
  auto_invoice_id?: string | null;
};

export function ReceiptModal({
  receipt, pos, onClose, onSaved,
}: {
  receipt: ReceiptRow | null;
  pos: PoOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = receipt === null;
  const status: ReceiptStatus = receipt?.status || "draft";
  const editable = isNew || status === "draft";

  const [poId, setPoId] = useState<string>(receipt?.tanda_po_id || "");
  const [receiptDate, setReceiptDate] = useState<string>(receipt?.receipt_date || new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState<string>(receipt?.notes || "");

  const [poLines, setPoLines] = useState<Array<{ id: string; line_index: number; item_number: string | null; description: string | null; qty_ordered: number | null; unit_price: number | null }>>([]);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [rollups, setRollups] = useState<DraftRollup[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(!isNew);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/internal/gl-accounts?limit=1000")
      .then((r) => r.json())
      .then((arr: unknown) => {
        if (Array.isArray(arr)) {
          setAccounts((arr as Account[]).filter((a) => a.status === "active" &&
            (a.account_type === "expense" || a.account_type === "revenue")));
        }
      })
      .catch(() => {});
    fetch("/api/internal/vendors?limit=1000")
      .then((r) => r.json())
      .then((arr: unknown) => { if (Array.isArray(arr)) setVendors(arr as Vendor[]); })
      .catch(() => {});
  }, []);

  // Lazy-load PO lines whenever poId changes for new receipt.
  useEffect(() => {
    if (!poId) { setPoLines([]); return; }
    let cancelled = false;
    fetch(`/api/internal/procurement/pos/${poId}`)
      .then((r) => r.json())
      .then((full: { lines?: Array<{ id: string; line_index: number; item_number: string | null; description: string | null; qty_ordered: number | null; unit_price: number | null }> }) => {
        if (cancelled) return;
        setPoLines(full.lines || []);
        if (isNew) {
          setLines((full.lines || []).map((l, i) => ({
            key: i + 1,
            po_line_item_id: l.id,
            description: l.item_number || l.description || "",
            qty_received: String(l.qty_ordered ?? ""),
            qty_accepted: String(l.qty_ordered ?? ""),
            qty_rejected: "0",
            unit_cost_dollars: String(l.unit_price ?? ""),
          })));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [poId, isNew]);

  // Lazy-load existing receipt lines + rollups on edit.
  useEffect(() => {
    if (isNew || !receipt) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/internal/procurement/receipts/${receipt.id}`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        const full = await r.json() as ReceiptFull;
        if (cancelled) return;
        setLines((full.lines || []).map((l, i) => ({
          key: i + 1,
          po_line_item_id: l.po_line_item_id,
          description: "",
          qty_received: String(l.qty_received),
          qty_accepted: String(l.qty_accepted),
          qty_rejected: String(l.qty_rejected || 0),
          unit_cost_dollars: centsToDollars(l.unit_cost_cents),
        })));
        setRollups((full.rollups || []).map((rr, i) => ({
          key: i + 1,
          expense_gl_account_id: rr.expense_gl_account_id,
          amount_dollars: centsToDollars(rr.amount_cents),
          vendor_id: rr.vendor_id || "",
          description: rr.description,
          capitalized_to_inventory: rr.capitalized_to_inventory,
          auto_invoice_id: rr.auto_invoice_id ?? null,
        })));
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [receipt, isNew]);

  function addRollup() {
    setRollups((rr) => [...rr, {
      key: (rr[rr.length - 1]?.key || 0) + 1,
      expense_gl_account_id: "",
      amount_dollars: "",
      vendor_id: "",
      description: "",
      capitalized_to_inventory: true,
    }]);
  }
  function updateRollup(idx: number, patch: Partial<DraftRollup>) {
    setRollups((rr) => rr.map((r, i) => i === idx ? { ...r, ...patch } : r));
  }
  function removeRollup(idx: number) {
    setRollups((rr) => rr.filter((_, i) => i !== idx));
  }

  function updateLine(idx: number, patch: Partial<DraftLine>) {
    setLines((ll) => ll.map((l, i) => i === idx ? { ...l, ...patch } : l));
  }

  const rollupsCapitalizedTotal = useMemo(() => {
    let total = 0n;
    for (const r of rollups) {
      if (!r.capitalized_to_inventory) continue;
      const cents = dollarsToCents(r.amount_dollars);
      if (cents !== null) total += cents;
    }
    return total;
  }, [rollups]);

  const rollupsTotal = useMemo(() => {
    let total = 0n;
    for (const r of rollups) {
      const cents = dollarsToCents(r.amount_dollars);
      if (cents !== null) total += cents;
    }
    return total;
  }, [rollups]);

  async function submitSaveDraft() {
    setSubmitting(true);
    setErr(null);
    try {
      const linePayload = lines.filter((l) => l.po_line_item_id && l.qty_received).map((l) => {
        const uc = dollarsToCents(l.unit_cost_dollars) ?? 0n;
        return {
          po_line_item_id: l.po_line_item_id,
          qty_received: parseInt(l.qty_received, 10),
          qty_accepted: parseInt(l.qty_accepted || l.qty_received, 10),
          qty_rejected: parseInt(l.qty_rejected || "0", 10),
          unit_cost_cents: uc.toString(),
        };
      });

      if (isNew) {
        const body: Record<string, unknown> = {
          tanda_po_id: poId,
          receipt_date: receiptDate,
          notes: notes.trim() || null,
          lines: linePayload,
          rollups: rollups
            .filter((r) => r.expense_gl_account_id && r.amount_dollars && r.description)
            .map((r) => ({
              expense_gl_account_id: r.expense_gl_account_id,
              amount_cents: (dollarsToCents(r.amount_dollars) || 0n).toString(),
              vendor_id: r.vendor_id || null,
              description: r.description,
              capitalized_to_inventory: r.capitalized_to_inventory,
            })),
        };
        const r = await fetch("/api/internal/procurement/receipts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      } else {
        const r = await fetch(`/api/internal/procurement/receipts/${receipt!.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            notes: notes.trim() || null,
            receipt_date: receiptDate,
            lines: editable ? linePayload : undefined,
          }),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        // Save rollups via replace endpoint.
        const sr = await fetch(`/api/internal/procurement/receipts/${receipt!.id}/save-rollups`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rollups: rollups
              .filter((rr) => rr.expense_gl_account_id && rr.amount_dollars && rr.description)
              .map((rr) => ({
                expense_gl_account_id: rr.expense_gl_account_id,
                amount_cents: (dollarsToCents(rr.amount_dollars) || 0n).toString(),
                vendor_id: rr.vendor_id || null,
                description: rr.description,
                capitalized_to_inventory: rr.capitalized_to_inventory,
              })),
          }),
        });
        if (!sr.ok) throw new Error((await sr.json().catch(() => ({}))).error || `HTTP ${sr.status}`);
      }

      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function transitionTo(next: ReceiptStatus) {
    if (!receipt) return;
    setSubmitting(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/procurement/receipts/${receipt.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const transitionTargets = ALLOWED_TRANSITIONS[status] || [];

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
      display: "flex", alignItems: "flex-start", justifyContent: "center",
      zIndex: 100, paddingTop: 40, paddingBottom: 40, overflowY: "auto",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10,
        padding: 20, width: 1200, maxWidth: "95vw", color: C.text,
      }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {isNew ? "New receipt" : `Edit receipt`}
          {!isNew && (
            <span style={{ marginLeft: 12, fontSize: 12, color: statusColor(status) }}>
              ● {status}
            </span>
          )}
        </h3>

        {loading ? (
          <div style={{ color: C.textMuted, padding: 24, textAlign: "center" }}>Loading…</div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 2fr", gap: 12, marginBottom: 12 }}>
              <Field label="PO">
                <SearchableSelect
                  value={poId || null}
                  onChange={(v) => setPoId(v)}
                  options={pos.map((p) => ({ value: p.id, label: `${p.po_number} — ${p.vendor}${p.pilot_vendor_flag ? " ★" : ""}` }))}
                  placeholder="(pick PO…)"
                  disabled={!isNew}
                />
              </Field>
              <Field label="Receipt date">
                <input type="date" value={receiptDate} onChange={(e) => setReceiptDate(e.target.value)} disabled={!editable} style={inputStyle} />
              </Field>
              <Field label="Notes">
                <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!editable} style={inputStyle} />
              </Field>
            </div>

            {/* Lines */}
            <div style={{ marginTop: 12, marginBottom: 6 }}>
              <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
                Received lines (pre-populated from PO)
              </div>
            </div>
            <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ ...th, width: 36 }}>#</th>
                    <th style={th}>Item</th>
                    <th style={{ ...th, width: 110 }}>Qty received</th>
                    <th style={{ ...th, width: 110 }}>Qty accepted</th>
                    <th style={{ ...th, width: 110 }}>Qty rejected</th>
                    <th style={{ ...th, width: 130 }}>Unit cost $</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.length === 0 ? (
                    <tr>
                      <td style={td} colSpan={6}>
                        <span style={{ color: C.textMuted, fontStyle: "italic" }}>
                          {poId ? "Loading PO lines…" : "Pick a PO to populate lines"}
                        </span>
                      </td>
                    </tr>
                  ) : lines.map((l, idx) => (
                    <tr key={l.key}>
                      <td style={td}>{idx + 1}</td>
                      <td style={td}>{l.description || (l.po_line_item_id ? l.po_line_item_id.slice(0, 8) : "")}</td>
                      <td style={td}>
                        <input type="number" min="0" step="1" value={l.qty_received} onChange={(e) => updateLine(idx, { qty_received: e.target.value })} disabled={!editable} style={inputStyle} />
                      </td>
                      <td style={td}>
                        <input type="number" min="0" step="1" value={l.qty_accepted} onChange={(e) => updateLine(idx, { qty_accepted: e.target.value })} disabled={!editable} style={inputStyle} />
                      </td>
                      <td style={td}>
                        <input type="number" min="0" step="1" value={l.qty_rejected} onChange={(e) => updateLine(idx, { qty_rejected: e.target.value })} disabled={!editable} style={inputStyle} />
                      </td>
                      <td style={td}>
                        <input type="text" value={l.unit_cost_dollars} onChange={(e) => updateLine(idx, { unit_cost_dollars: e.target.value })} disabled={!editable} style={inputStyle} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* D19 Rollups */}
            <div style={{ marginTop: 12, marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
                D19 Rollups (freight / brokerage / duty / inspection)
                <span style={{ marginLeft: 16, color: C.textSub, textTransform: "none", letterSpacing: 0, fontSize: 12 }}>
                  Capitalized total <strong style={{ color: C.text }}>{fmtCents(rollupsCapitalizedTotal.toString())}</strong>
                  {" · "}All rollups <strong style={{ color: C.text }}>{fmtCents(rollupsTotal.toString())}</strong>
                </span>
              </div>
              {status !== "posted" && (
                <button type="button" onClick={addRollup} style={btnSecondary}>+ Add rollup line</button>
              )}
            </div>

            <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ ...th, width: 36 }}>#</th>
                    <th style={th}>Expense GL account</th>
                    <th style={{ ...th, width: 130 }}>Amount $</th>
                    <th style={th}>Vendor (optional)</th>
                    <th style={th}>Description</th>
                    <th style={{ ...th, width: 80, textAlign: "center" }}>Capitalize?</th>
                    <th style={{ ...th, width: 90 }}>AP invoice</th>
                    <th style={{ ...th, width: 36 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rollups.length === 0 ? (
                    <tr>
                      <td style={td} colSpan={8}>
                        <span style={{ color: C.textMuted, fontStyle: "italic" }}>No rollups yet. Click + Add rollup line above to capture freight, brokerage, duty, or inspection charges.</span>
                      </td>
                    </tr>
                  ) : rollups.map((rr, idx) => (
                    <tr key={rr.key}>
                      <td style={td}>{idx + 1}</td>
                      <td style={td}>
                        <SearchableSelect
                          value={rr.expense_gl_account_id || null}
                          onChange={(v) => updateRollup(idx, { expense_gl_account_id: v })}
                          options={accounts.map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` }))}
                          placeholder="(pick GL account…)"
                          disabled={status === "posted"}
                        />
                      </td>
                      <td style={td}>
                        <input type="text" value={rr.amount_dollars} onChange={(e) => updateRollup(idx, { amount_dollars: e.target.value })} disabled={status === "posted"} placeholder="0.00" style={inputStyle} />
                      </td>
                      <td style={td}>
                        <SearchableSelect
                          value={rr.vendor_id || null}
                          onChange={(v) => updateRollup(idx, { vendor_id: v })}
                          options={[{ value: "", label: "(use PO vendor)" }, ...vendors.map((v) => ({ value: v.id, label: v.name }))]}
                          placeholder="(use PO vendor)"
                          disabled={status === "posted"}
                        />
                      </td>
                      <td style={td}>
                        <input type="text" value={rr.description} onChange={(e) => updateRollup(idx, { description: e.target.value })} disabled={status === "posted"} placeholder="e.g. freight forwarder invoice #1234" style={inputStyle} />
                      </td>
                      <td style={{ ...td, textAlign: "center" }}>
                        <input type="checkbox" checked={rr.capitalized_to_inventory} onChange={(e) => updateRollup(idx, { capitalized_to_inventory: e.target.checked })} disabled={status === "posted"} />
                      </td>
                      <td style={{ ...td, fontSize: 10, color: C.textMuted }}>
                        {rr.auto_invoice_id ? (
                          <span title={rr.auto_invoice_id}>pending bk</span>
                        ) : ""}
                      </td>
                      <td style={td}>
                        {status !== "posted" && (
                          <button type="button" onClick={() => removeRollup(idx)} style={btnDanger}>✕</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {!isNew && transitionTargets.length > 0 && (
              <div style={{ marginBottom: 16, padding: 12, background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>
                <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Status transitions</div>
                {transitionTargets.map((t) => (
                  <button key={t} onClick={() => void transitionTo(t)} style={{ ...btnSuccess, marginRight: 6 }} disabled={submitting}>
                    {t === "pending_approval" ? "Submit for approval" :
                     t === "approved"         ? "Approve receipt" :
                     t === "posted"           ? "Post receipt" :
                     t === "draft"            ? "Return to draft" :
                     t}
                  </button>
                ))}
              </div>
            )}

            {err && (
              <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
                {err}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={onClose} style={btnSecondary} disabled={submitting}>Close</button>
              {status !== "posted" && (
                <button onClick={() => void submitSaveDraft()} style={btnPrimary}
                        disabled={submitting || !poId || lines.length === 0}>
                  {submitting ? "Saving…" : (isNew ? "Save as draft" : "Save changes")}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function centsToDollars(cents: string | null | undefined): string {
  if (!cents) return "";
  let bi: bigint;
  try { bi = BigInt(cents); } catch { return ""; }
  const neg = bi < 0n;
  const abs = neg ? -bi : bi;
  const whole = (abs / 100n).toString();
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      {children}
    </div>
  );
}
