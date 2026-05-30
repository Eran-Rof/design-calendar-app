// src/tanda/InternalPOOrigination.tsx
//
// Tangerine P13-3 — M11 Procurement PO origination panel.
//
// Lists tanda_pos filtered to procurement_status IN (draft, pending_approval,
// approved, open). "+ New PO" opens a modal that captures vendor, optional
// po_number (auto-generated ROF-PNNNNNN otherwise), date order/expected,
// expected_landed_cost ($ — D9 strict, required), pilot vendor flag, plus
// a line items grid (SKU / qty / unit price). Save creates a draft via
// POST /api/internal/procurement/pos.
//
// Click any row to open the detail modal — editable while draft, with
// status-transition buttons (Submit for approval / Approve / Open / Cancel)
// gated by current procurement_status. Cancel prompts for a reason (T11 D3).
//
// Cross-cutters: DateRangePresets (T7), SearchableSelect (T9),
// ExportButton (T3/T8). RowHistory drop-in lands once T11-3 ships.

import { useEffect, useMemo, useState } from "react";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import SearchableSelect from "./components/SearchableSelect";
import DateRangePresets from "./components/DateRangePresets.tsx";

export type ProcurementStatus =
  | "draft" | "pending_approval" | "approved" | "open"
  | "received" | "closed" | "cancelled";

export type PoRow = {
  id: string;
  po_number: string;
  vendor: string;
  vendor_id: string | null;
  buyer_po: string | null;
  buyer_name: string | null;
  date_order: string | null;
  date_expected: string | null;
  status: string | null;
  procurement_status: ProcurementStatus | null;
  expected_landed_cost_cents: string | null;
  actual_landed_cost_cents: string | null;
  pilot_vendor_flag: boolean;
  originated_by_employee_id: string | null;
  created_at: string;
  updated_at: string;
};

export type PoLine = {
  id?: string;
  po_id?: string;
  line_index: number;
  item_number: string | null;
  description: string | null;
  qty_ordered: number | string | null;
  qty_remaining: number | string | null;
  unit_price: number | string | null;
  line_total: number | string | null;
};

export type PoFull = PoRow & { lines: PoLine[] };

type Vendor = { id: string; name: string; pilot_vendor?: boolean };

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
  pilot: "#fb923c",
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
const btnWarn: React.CSSProperties = { ...btnSecondary, color: C.warn, borderColor: "#78350f" };
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

export function statusColor(s: ProcurementStatus | null): string {
  if (s === "approved" || s === "open") return C.success;
  if (s === "pending_approval") return C.warn;
  if (s === "received") return C.primary;
  if (s === "cancelled" || s === "closed") return C.danger;
  return C.textMuted;
}

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

export function dollarsToCentsBigInt(s: string): bigint | null {
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

export const PROCUREMENT_STATUS_OPTIONS: { value: ProcurementStatus | ""; label: string }[] = [
  { value: "",                 label: "All active statuses" },
  { value: "draft",            label: "Draft" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "approved",         label: "Approved" },
  { value: "open",             label: "Open" },
  { value: "received",         label: "Received" },
  { value: "closed",           label: "Closed" },
  { value: "cancelled",        label: "Cancelled" },
];

export const ALLOWED_TRANSITIONS: Record<string, ProcurementStatus[]> = {
  draft:            ["pending_approval", "cancelled"],
  pending_approval: ["approved", "cancelled", "draft"],
  approved:         ["open", "cancelled"],
  open:             ["received", "cancelled"],
  received:         [],
  closed:           [],
  cancelled:        [],
};

export default function InternalPOOrigination() {
  const [rows, setRows] = useState<PoRow[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<ProcurementStatus | "">("");
  const [vendorFilter, setVendorFilter] = useState<string>("");
  const [pilotOnly, setPilotOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [includeTerminal, setIncludeTerminal] = useState(false);
  const [limit, setLimit] = useState(200);

  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<PoRow | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams({ limit: String(limit) });
      if (statusFilter) params.set("status", statusFilter);
      if (vendorFilter) params.set("vendor_id", vendorFilter);
      if (pilotOnly) params.set("pilot", "true");
      if (search.trim()) params.set("q", search.trim());
      if (fromDate) params.set("from", fromDate);
      if (toDate) params.set("to", toDate);
      if (includeTerminal) params.set("include_terminal", "true");
      const r = await fetch(`/api/internal/procurement/pos?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as PoRow[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [statusFilter, vendorFilter, pilotOnly, includeTerminal, fromDate, toDate, limit]);

  useEffect(() => {
    fetch("/api/internal/vendors?limit=1000")
      .then((r) => r.json())
      .then((arr: unknown) => { if (Array.isArray(arr)) setVendors(arr as Vendor[]); })
      .catch(() => {});
  }, []);

  const vendorMap = useMemo(() => {
    const m: Record<string, Vendor> = {};
    for (const v of vendors) m[v.id] = v;
    return m;
  }, [vendors]);

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>📦 Procurement — PO Origination</h2>
        <button onClick={() => { setEditing(null); setEditOpen(true); }} style={btnPrimary}>
          + New PO
        </button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as ProcurementStatus | "")} style={{ ...inputStyle, width: 200 }}>
          {PROCUREMENT_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <div style={{ width: 240 }}>
          <SearchableSelect
            value={vendorFilter || null}
            onChange={(v) => setVendorFilter(v)}
            options={[{ value: "", label: "All vendors" }, ...vendors.map((v) => ({ value: v.id, label: v.name }))]}
            placeholder="All vendors"
          />
        </div>
        <input
          type="text" placeholder="Search PO #" value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void load(); }}
          style={{ ...inputStyle, width: 200 }}
        />
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
          <input type="checkbox" checked={pilotOnly} onChange={(e) => setPilotOnly(e.target.checked)} />
          Pilot vendor only
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input type="checkbox" checked={includeTerminal} onChange={(e) => setIncludeTerminal(e.target.checked)} />
          Include received/closed/cancelled
        </label>
        <ExportButton
          rows={rows.map((p) => ({
            po_number: p.po_number,
            vendor: vendorMap[p.vendor_id || ""]?.name || p.vendor || p.vendor_id || "",
            buyer_po: p.buyer_po,
            date_order: p.date_order,
            date_expected: p.date_expected,
            procurement_status: p.procurement_status,
            pilot: p.pilot_vendor_flag,
            expected_landed_cost_cents: p.expected_landed_cost_cents,
            actual_landed_cost_cents: p.actual_landed_cost_cents,
          })) as unknown as Array<Record<string, unknown>>}
          filename="procurement-pos"
          sheetName="Procurement POs"
          columns={[
            { key: "po_number",                  header: "PO #" },
            { key: "vendor",                     header: "Vendor" },
            { key: "buyer_po",                   header: "Buyer PO" },
            { key: "date_order",                 header: "Order Date", format: "date" },
            { key: "date_expected",              header: "Expected", format: "date" },
            { key: "procurement_status",         header: "Status" },
            { key: "pilot",                      header: "Pilot vendor" },
            { key: "expected_landed_cost_cents", header: "Expected Landed", format: "currency_cents" },
            { key: "actual_landed_cost_cents",   header: "Actual Landed",   format: "currency_cents" },
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
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No procurement POs.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 160 }}>PO #</th>
                <th style={th}>Vendor</th>
                <th style={th}>Order Date</th>
                <th style={th}>Expected</th>
                <th style={th}>Status</th>
                <th style={{ ...th, textAlign: "right" }}>Expected Landed</th>
                <th style={{ ...th, width: 90, textAlign: "center" }}>Pilot</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} onClick={() => { setEditing(p); setEditOpen(true); }} style={{ cursor: "pointer" }}>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }}>{p.po_number}</td>
                  <td style={td}>{vendorMap[p.vendor_id || ""]?.name || p.vendor || (p.vendor_id || "").slice(0, 8)}</td>
                  <td style={td}>{p.date_order || ""}</td>
                  <td style={td}>{p.date_expected || ""}</td>
                  <td style={td}>
                    <span style={{ color: statusColor(p.procurement_status), fontWeight: 600 }}>
                      ● {p.procurement_status || "—"}
                    </span>
                  </td>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", textAlign: "right" }}>
                    {fmtCents(p.expected_landed_cost_cents)}
                  </td>
                  <td style={{ ...td, textAlign: "center" }}>
                    {p.pilot_vendor_flag ? (
                      <span style={{ color: C.pilot, fontWeight: 600 }}>★</span>
                    ) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editOpen && (
        <PoModal
          po={editing}
          vendors={vendors}
          onClose={() => { setEditOpen(false); setEditing(null); }}
          onSaved={() => { setEditOpen(false); setEditing(null); void load(); }}
        />
      )}

      <div style={{ marginTop: 16, padding: 12, background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, fontSize: 11, color: C.textMuted }}>
        {/* RowHistory drop-in (T11-3) lands once that cross-cutter ships. */}
        Audit log surfaces here once T11-3 RowHistory drop-in ships.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// New / Edit modal
// ─────────────────────────────────────────────────────────────────────

type DraftLine = {
  key: number;
  item_number: string;
  description: string;
  qty_ordered: string;
  unit_price_dollars: string;
};

export function PoModal({
  po, vendors, onClose, onSaved,
}: {
  po: PoRow | null;
  vendors: Vendor[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = po === null;
  const status: ProcurementStatus = (po?.procurement_status as ProcurementStatus) || "draft";
  const editable = isNew || status === "draft";

  const [vendorId, setVendorId] = useState(po?.vendor_id || "");
  const [poNumber, setPoNumber] = useState(po?.po_number || "");
  const [dateOrder, setDateOrder] = useState(po?.date_order || new Date().toISOString().slice(0, 10));
  const [dateExpected, setDateExpected] = useState(po?.date_expected || "");
  const [buyerPo, setBuyerPo] = useState(po?.buyer_po || "");
  const [buyerName, setBuyerName] = useState(po?.buyer_name || "");
  const [pilotFlag, setPilotFlag] = useState<boolean>(po?.pilot_vendor_flag ?? false);
  const [expectedLandedDollars, setExpectedLandedDollars] = useState<string>(() => {
    if (po?.expected_landed_cost_cents) {
      const bi = BigInt(po.expected_landed_cost_cents);
      const w = (bi / 100n).toString();
      const f = (bi % 100n).toString().padStart(2, "0");
      return `${w}.${f}`;
    }
    return "";
  });

  const [lines, setLines] = useState<DraftLine[]>([
    { key: 1, item_number: "", description: "", qty_ordered: "", unit_price_dollars: "" },
  ]);
  const [loading, setLoading] = useState(!isNew);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Lazy-load existing lines on edit.
  useEffect(() => {
    if (isNew || !po) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/internal/procurement/pos/${po.id}`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        const full = await r.json() as PoFull;
        if (cancelled) return;
        if (full.lines?.length > 0) {
          setLines(full.lines.map((l, i) => ({
            key: i + 1,
            item_number: l.item_number || "",
            description: l.description || "",
            qty_ordered: l.qty_ordered != null ? String(l.qty_ordered) : "",
            unit_price_dollars: l.unit_price != null ? String(l.unit_price) : "",
          })));
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [po, isNew]);

  function addLine() {
    setLines((ll) => [...ll, {
      key: (ll[ll.length - 1]?.key || 0) + 1,
      item_number: "", description: "", qty_ordered: "", unit_price_dollars: "",
    }]);
  }
  function updateLine(idx: number, patch: Partial<DraftLine>) {
    setLines((ll) => ll.map((l, i) => i === idx ? { ...l, ...patch } : l));
  }
  function removeLine(idx: number) {
    if (lines.length <= 1) return;
    setLines((ll) => ll.filter((_, i) => i !== idx));
  }

  const lineTotalDollars = useMemo(() => {
    let total = 0;
    for (const l of lines) {
      const q = Number(l.qty_ordered);
      const p = Number(l.unit_price_dollars);
      if (Number.isFinite(q) && Number.isFinite(p)) total += q * p;
    }
    return total;
  }, [lines]);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const elcCents = dollarsToCentsBigInt(expectedLandedDollars);
      if (elcCents === null) {
        throw new Error("Expected landed cost is required (D9 strict)");
      }
      const body: Record<string, unknown> = {
        vendor_id: vendorId,
        po_number: poNumber.trim() || null,
        date_order: dateOrder || null,
        date_expected: dateExpected || null,
        buyer_po: buyerPo.trim() || null,
        buyer_name: buyerName.trim() || null,
        expected_landed_cost_cents: elcCents.toString(),
        pilot_vendor_flag: pilotFlag,
        lines: lines
          .filter((l) => l.qty_ordered || l.item_number || l.description)
          .map((l) => ({
            item_number: l.item_number.trim() || null,
            description: l.description.trim() || null,
            qty_ordered: Number(l.qty_ordered) || 0,
            unit_price_dollars: Number(l.unit_price_dollars) || 0,
          })),
      };

      let r: Response;
      if (isNew) {
        r = await fetch("/api/internal/procurement/pos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        const patch: Record<string, unknown> = {
          expected_landed_cost_cents: elcCents.toString(),
          date_order: dateOrder || null,
          date_expected: dateExpected || null,
          buyer_po: buyerPo.trim() || null,
          buyer_name: buyerName.trim() || null,
        };
        r = await fetch(`/api/internal/procurement/pos/${po!.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
      }
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function transitionTo(next: ProcurementStatus) {
    if (!po) return;
    let body: Record<string, unknown> = { procurement_status: next };
    if (next === "cancelled") {
      const reason = prompt("Cancel reason (required for audit log):", "");
      if (!reason || !reason.trim()) return;
      body = { procurement_status: "cancelled", cancel_reason: reason.trim() };
    }
    setSubmitting(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/procurement/pos/${po.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const formValid = !!vendorId && !!expectedLandedDollars && dollarsToCentsBigInt(expectedLandedDollars) !== null;
  const transitionTargets = ALLOWED_TRANSITIONS[status] || [];

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
      display: "flex", alignItems: "flex-start", justifyContent: "center",
      zIndex: 100, paddingTop: 40, paddingBottom: 40, overflowY: "auto",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10,
        padding: 20, width: 1100, maxWidth: "95vw", color: C.text,
      }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {isNew ? "New PO" : `Edit PO ${po?.po_number}`}
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
            {!editable && (
              <div style={{ background: "#78350f", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 12 }}>
                This PO is in status <strong>{status}</strong> and header fields cannot be edited. Use the status buttons below to transition.
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
              <Field label="Vendor">
                <SearchableSelect
                  value={vendorId || null}
                  onChange={(v) => setVendorId(v)}
                  options={vendors.map((v) => ({ value: v.id, label: v.pilot_vendor ? `★ ${v.name}` : v.name }))}
                  placeholder="(pick vendor…)"
                  disabled={!editable}
                />
              </Field>
              <Field label="PO number">
                <input type="text" value={poNumber} onChange={(e) => setPoNumber(e.target.value)}
                       placeholder="(auto-generated ROF-PNNNNNN if blank)" disabled={!isNew} style={inputStyle} />
              </Field>
              <Field label="Pilot vendor (D18)">
                <label style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 8 }}>
                  <input type="checkbox" checked={pilotFlag} onChange={(e) => setPilotFlag(e.target.checked)} disabled={!editable} />
                  <span style={{ color: pilotFlag ? C.pilot : C.textMuted, fontWeight: 600 }}>
                    {pilotFlag ? "★ Pilot" : "Not pilot"}
                  </span>
                </label>
              </Field>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
              <Field label="Order date">
                <input type="date" value={dateOrder} onChange={(e) => setDateOrder(e.target.value)} disabled={!editable} style={inputStyle} />
              </Field>
              <Field label="Expected">
                <input type="date" value={dateExpected} onChange={(e) => setDateExpected(e.target.value)} disabled={!editable} style={inputStyle} />
              </Field>
              <Field label="Buyer PO">
                <input type="text" value={buyerPo} onChange={(e) => setBuyerPo(e.target.value)} disabled={!editable} style={inputStyle} />
              </Field>
              <Field label="Buyer name">
                <input type="text" value={buyerName} onChange={(e) => setBuyerName(e.target.value)} disabled={!editable} style={inputStyle} />
              </Field>
            </div>

            <div style={{ marginBottom: 12 }}>
              <Field label="Expected landed cost ($) — D9 strict, required">
                <input type="text" value={expectedLandedDollars}
                       onChange={(e) => setExpectedLandedDollars(e.target.value)}
                       disabled={!editable}
                       placeholder="0.00 (required)"
                       style={inputStyle} />
              </Field>
            </div>

            <div style={{ marginTop: 16, marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Line items</div>
              {editable && (
                <button type="button" onClick={addLine} style={btnSecondary}>+ Add line</button>
              )}
            </div>

            <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ ...th, width: 36 }}>#</th>
                    <th style={th}>SKU / item</th>
                    <th style={th}>Description</th>
                    <th style={{ ...th, width: 90 }}>Qty</th>
                    <th style={{ ...th, width: 110 }}>Unit $</th>
                    <th style={{ ...th, width: 110, textAlign: "right" }}>Line total</th>
                    <th style={{ ...th, width: 36 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, idx) => {
                    const qty = Number(l.qty_ordered);
                    const price = Number(l.unit_price_dollars);
                    const lineTotal = Number.isFinite(qty) && Number.isFinite(price) ? qty * price : 0;
                    return (
                      <tr key={l.key}>
                        <td style={td}>{idx + 1}</td>
                        <td style={td}>
                          <input type="text" value={l.item_number} onChange={(e) => updateLine(idx, { item_number: e.target.value })} disabled={!editable} style={inputStyle} />
                        </td>
                        <td style={td}>
                          <input type="text" value={l.description} onChange={(e) => updateLine(idx, { description: e.target.value })} disabled={!editable} style={inputStyle} />
                        </td>
                        <td style={td}>
                          <input type="number" min="0" step="1" value={l.qty_ordered} onChange={(e) => updateLine(idx, { qty_ordered: e.target.value })} disabled={!editable} style={inputStyle} />
                        </td>
                        <td style={td}>
                          <input type="text" value={l.unit_price_dollars} onChange={(e) => updateLine(idx, { unit_price_dollars: e.target.value })} disabled={!editable} style={inputStyle} />
                        </td>
                        <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", textAlign: "right" }}>
                          ${lineTotal.toFixed(2)}
                        </td>
                        <td style={td}>
                          {editable && lines.length > 1 && (
                            <button type="button" onClick={() => removeLine(idx)} style={btnDanger}>✕</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td style={td} colSpan={5}>
                      <span style={{ color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Line total</span>
                    </td>
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 700, textAlign: "right" }}>
                      ${lineTotalDollars.toFixed(2)}
                    </td>
                    <td style={td}></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {!isNew && transitionTargets.length > 0 && (
              <div style={{ marginBottom: 16, padding: 12, background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>
                <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Status transitions</div>
                {transitionTargets.map((t) => (
                  <button key={t} onClick={() => void transitionTo(t)}
                          style={{ ...(t === "cancelled" ? btnWarn : btnSuccess), marginRight: 6 }}
                          disabled={submitting}>
                    {t === "pending_approval" ? "Submit for approval" :
                     t === "approved"         ? "Approve" :
                     t === "open"             ? "Open (release to vendor)" :
                     t === "cancelled"        ? "Cancel…" :
                     t === "received"         ? "Mark received" :
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
              {editable && (
                <button onClick={() => void submit()} style={btnPrimary} disabled={submitting || !formValid}>
                  {submitting ? "Saving…" : (isNew ? "Create draft" : "Save changes")}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      {children}
    </div>
  );
}
