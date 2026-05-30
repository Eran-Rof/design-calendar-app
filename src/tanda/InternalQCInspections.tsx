// src/tanda/InternalQCInspections.tsx
//
// Tangerine P13-5 — M26 QC Inspections panel.
//
// Lists tanda_po_qc_inspections in status IN (pending, failed, partial) by
// default. "+ New inspection" opens a modal that captures the source
// receipt (SearchableSelect), inspector, inspection date, status, overall
// pass rate, notes, and a findings sub-section (Add / edit / delete per
// finding with category / severity / qty_affected / description /
// photo_urls / resolution).
//
// Failed-inspection workflow integration (P7-9 cases): when an inspection
// PATCH moves status to 'failed' AND has any severity='critical' findings,
// the backend auto-creates a case (subject "QC failure — PO {po_number}
// — {N} critical findings") and links it via inspection.case_id. The UI
// surfaces the linked case id and shows a banner.
//
// Cross-cutters: DateRangePresets (T7), SearchableSelect (T9),
// ExportButton (T3/T8). RowHistory drop-in (T11-3) lands once that
// cross-cutter ships; until then the panel reserves the slot.
//
// T11 D3 — finding DELETE prompts the operator for a reason; the reason
// is sent in the request body and stored against the audit log.

import { useEffect, useMemo, useState } from "react";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import SearchableSelect from "./components/SearchableSelect";
import DateRangePresets from "./components/DateRangePresets.tsx";

export type InspectionStatus = "pending" | "passed" | "failed" | "partial";
export type FindingSeverity = "minor" | "major" | "critical";

export type InspectionRow = {
  id: string;
  entity_id: string;
  receipt_id: string;
  inspection_date: string;
  inspector_employee_id: string | null;
  status: InspectionStatus;
  overall_pass_rate: number | null;
  notes: string | null;
  case_id: string | null;
  created_at: string;
};

export type Finding = {
  id?: string;
  inspection_id?: string;
  category: string;
  severity: FindingSeverity;
  qty_affected: number;
  description: string;
  photo_urls: string[] | null;
  resolution: string | null;
  created_at?: string;
};

export type InspectionFull = InspectionRow & { findings: Finding[] };

type ReceiptOption = {
  id: string;
  tanda_po_id: string;
  receipt_date: string;
  status: string;
};

type Employee = { id: string; name: string };

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

export const STATUS_OPTIONS: { value: InspectionStatus | ""; label: string }[] = [
  { value: "",        label: "Open (default)" },
  { value: "pending", label: "Pending" },
  { value: "partial", label: "Partial" },
  { value: "failed",  label: "Failed" },
  { value: "passed",  label: "Passed" },
];

export const SEVERITY_OPTIONS: { value: FindingSeverity; label: string }[] = [
  { value: "minor",    label: "Minor" },
  { value: "major",    label: "Major" },
  { value: "critical", label: "Critical" },
];

export function statusColor(s: InspectionStatus): string {
  if (s === "passed") return C.success;
  if (s === "failed") return C.danger;
  if (s === "partial") return C.warn;
  return C.textMuted;
}

export function severityColor(s: FindingSeverity): string {
  if (s === "critical") return C.danger;
  if (s === "major")    return C.warn;
  return C.textMuted;
}

// Pure helper: derive auto pass rate from findings.
// passing_qty = total_inspected - sum(qty_affected); rate = passing / total.
// If no qty data is available we return null so the operator override stays.
export function computeAutoPassRate(findings: Finding[], totalInspected: number): number | null {
  if (!Number.isFinite(totalInspected) || totalInspected <= 0) return null;
  let affected = 0;
  for (const f of findings) {
    if (Number.isFinite(f.qty_affected)) affected += f.qty_affected;
  }
  const passing = Math.max(totalInspected - affected, 0);
  return Math.max(0, Math.min(1, passing / totalInspected));
}

export const ALLOWED_TRANSITIONS: Record<InspectionStatus, InspectionStatus[]> = {
  pending: ["passed", "failed", "partial"],
  partial: ["passed", "failed"],
  passed:  [],
  failed:  [],
};

export default function InternalQCInspections() {
  const [rows, setRows] = useState<InspectionRow[]>([]);
  const [receipts, setReceipts] = useState<ReceiptOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<InspectionStatus | "">("");
  const [receiptFilter, setReceiptFilter] = useState<string>("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [includePassed, setIncludePassed] = useState(false);
  const [limit, setLimit] = useState(200);

  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<InspectionRow | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams({ limit: String(limit) });
      if (statusFilter) params.set("status", statusFilter);
      if (receiptFilter) params.set("receipt_id", receiptFilter);
      if (fromDate) params.set("from", fromDate);
      if (toDate) params.set("to", toDate);
      if (includePassed) params.set("include_passed", "true");
      const r = await fetch(`/api/internal/procurement/qc-inspections?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as InspectionRow[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [statusFilter, receiptFilter, includePassed, fromDate, toDate, limit]);

  useEffect(() => {
    fetch("/api/internal/procurement/receipts?limit=500&include_posted=true")
      .then((r) => r.json())
      .then((arr: unknown) => { if (Array.isArray(arr)) setReceipts(arr as ReceiptOption[]); })
      .catch(() => {});
  }, []);

  const receiptMap = useMemo(() => {
    const m: Record<string, ReceiptOption> = {};
    for (const r of receipts) m[r.id] = r;
    return m;
  }, [receipts]);

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>📦 Procurement — QC Inspections</h2>
        <button onClick={() => { setEditing(null); setEditOpen(true); }} style={btnPrimary}>
          + New inspection
        </button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as InspectionStatus | "")} style={{ ...inputStyle, width: 200 }}>
          {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <div style={{ width: 280 }}>
          <SearchableSelect
            value={receiptFilter || null}
            onChange={(v) => setReceiptFilter(v)}
            options={[{ value: "", label: "All receipts" }, ...receipts.map((r) => ({ value: r.id, label: `${r.id.slice(0, 8)} — ${r.receipt_date}` }))]}
            placeholder="All receipts"
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
          <input type="checkbox" checked={includePassed} onChange={(e) => setIncludePassed(e.target.checked)} />
          Include passed
        </label>
        <ExportButton
          rows={rows.map((r) => ({
            inspection_id: r.id,
            receipt_id: r.receipt_id,
            inspection_date: r.inspection_date,
            status: r.status,
            overall_pass_rate: r.overall_pass_rate,
            case_id: r.case_id,
            notes: r.notes,
          })) as unknown as Array<Record<string, unknown>>}
          filename="qc-inspections"
          sheetName="QC Inspections"
          columns={[
            { key: "inspection_id",     header: "Inspection ID" },
            { key: "receipt_id",        header: "Receipt ID" },
            { key: "inspection_date",   header: "Inspection Date", format: "date" },
            { key: "status",            header: "Status" },
            { key: "overall_pass_rate", header: "Pass Rate" },
            { key: "case_id",           header: "Linked Case" },
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
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No inspections.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 200 }}>Inspection ID</th>
                <th style={th}>Receipt</th>
                <th style={th}>Inspection Date</th>
                <th style={th}>Status</th>
                <th style={{ ...th, textAlign: "right" }}>Pass Rate</th>
                <th style={th}>Linked Case</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} onClick={() => { setEditing(r); setEditOpen(true); }} style={{ cursor: "pointer" }}>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }}>{r.id.slice(0, 12)}…</td>
                  <td style={td}>
                    {receiptMap[r.receipt_id]
                      ? `${r.receipt_id.slice(0, 8)} — ${receiptMap[r.receipt_id].receipt_date}`
                      : r.receipt_id.slice(0, 12) + "…"}
                  </td>
                  <td style={td}>{r.inspection_date}</td>
                  <td style={td}>
                    <span style={{ color: statusColor(r.status), fontWeight: 600 }}>● {r.status}</span>
                  </td>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", textAlign: "right" }}>
                    {r.overall_pass_rate === null ? "—" : `${(r.overall_pass_rate * 100).toFixed(1)}%`}
                  </td>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 11, color: C.textMuted }}>
                    {r.case_id ? r.case_id.slice(0, 12) + "…" : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editOpen && (
        <InspectionModal
          inspection={editing}
          receipts={receipts}
          onClose={() => { setEditOpen(false); setEditing(null); }}
          onSaved={() => { setEditOpen(false); setEditing(null); void load(); }}
        />
      )}

      <div style={{ marginTop: 16, padding: 12, background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, fontSize: 11, color: C.textMuted }}>
        Audit log surfaces here once T11-3 RowHistory drop-in ships
        (source_table='tanda_po_qc_inspections').
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Inspection modal — supports new + edit + finding CRUD
// ─────────────────────────────────────────────────────────────────────

type DraftFinding = {
  key: number;
  id?: string;            // present when persisted
  category: string;
  severity: FindingSeverity;
  qty_affected: string;
  description: string;
  photo_urls: string;     // newline-separated for textarea entry
  resolution: string;
  editing?: boolean;
};

export function InspectionModal({
  inspection, receipts, onClose, onSaved,
}: {
  inspection: InspectionRow | null;
  receipts: ReceiptOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = inspection === null;
  const status: InspectionStatus = inspection?.status || "pending";
  const editable = isNew || status === "pending" || status === "partial";

  const [receiptId, setReceiptId] = useState<string>(inspection?.receipt_id || "");
  const [inspectionDate, setInspectionDate] = useState<string>(inspection?.inspection_date || new Date().toISOString().slice(0, 10));
  const [inspectorId, setInspectorId] = useState<string>(inspection?.inspector_employee_id || "");
  const [overallPassRate, setOverallPassRate] = useState<string>(
    inspection?.overall_pass_rate !== null && inspection?.overall_pass_rate !== undefined
      ? String(inspection.overall_pass_rate)
      : "",
  );
  const [overrideRate, setOverrideRate] = useState<boolean>(
    inspection?.overall_pass_rate !== null && inspection?.overall_pass_rate !== undefined,
  );
  const [totalInspected, setTotalInspected] = useState<string>("");
  const [notes, setNotes] = useState<string>(inspection?.notes || "");

  const [findings, setFindings] = useState<DraftFinding[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(!isNew);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [autoCaseId, setAutoCaseId] = useState<string | null>(inspection?.case_id || null);

  useEffect(() => {
    fetch("/api/internal/employees?limit=1000")
      .then((r) => r.json())
      .then((arr: unknown) => { if (Array.isArray(arr)) setEmployees(arr as Employee[]); })
      .catch(() => {});
  }, []);

  // Lazy-load existing findings on edit.
  useEffect(() => {
    if (isNew || !inspection) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/internal/procurement/qc-inspections/${inspection.id}`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        const full = await r.json() as InspectionFull;
        if (cancelled) return;
        setFindings((full.findings || []).map((f, i) => ({
          key: i + 1,
          id: f.id,
          category: f.category,
          severity: f.severity,
          qty_affected: String(f.qty_affected || 0),
          description: f.description,
          photo_urls: (f.photo_urls || []).join("\n"),
          resolution: f.resolution || "",
        })));
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [inspection, isNew]);

  // Auto pass-rate (operator can override via the checkbox).
  const autoRate = useMemo(() => {
    const findingsForCalc: Finding[] = findings.map((f) => ({
      category: f.category,
      severity: f.severity,
      qty_affected: parseInt(f.qty_affected || "0", 10) || 0,
      description: f.description,
      photo_urls: null,
      resolution: null,
    }));
    const t = parseInt(totalInspected, 10);
    if (!Number.isFinite(t) || t <= 0) return null;
    return computeAutoPassRate(findingsForCalc, t);
  }, [findings, totalInspected]);

  const effectiveRate = overrideRate
    ? parseFloat(overallPassRate || "")
    : (autoRate ?? null);

  function addFinding() {
    setFindings((ff) => [...ff, {
      key: (ff[ff.length - 1]?.key || 0) + 1,
      category: "",
      severity: "minor",
      qty_affected: "0",
      description: "",
      photo_urls: "",
      resolution: "",
      editing: true,
    }]);
  }
  function updateFinding(idx: number, patch: Partial<DraftFinding>) {
    setFindings((ff) => ff.map((f, i) => i === idx ? { ...f, ...patch } : f));
  }

  async function persistFinding(idx: number) {
    if (!inspection) return;   // need a parent
    const f = findings[idx];
    setSubmitting(true);
    setErr(null);
    try {
      const photoArr = f.photo_urls.split("\n").map((s) => s.trim()).filter(Boolean);
      const body = {
        inspection_id: inspection.id,
        category: f.category.trim(),
        severity: f.severity,
        qty_affected: parseInt(f.qty_affected || "0", 10) || 0,
        description: f.description.trim(),
        photo_urls: photoArr.length ? photoArr : null,
        resolution: f.resolution.trim() || null,
      };
      let r: Response;
      if (f.id) {
        r = await fetch(`/api/internal/procurement/qc-findings/${f.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        r = await fetch("/api/internal/procurement/qc-findings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const saved = await r.json() as Finding;
      updateFinding(idx, { id: saved.id, editing: false });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function removeFinding(idx: number) {
    const f = findings[idx];
    if (!f.id) {
      // Not yet persisted — drop from local state only.
      setFindings((ff) => ff.filter((_, i) => i !== idx));
      return;
    }
    // T11 D3 — destructive op requires a reason.
    const reason = prompt("Delete reason (required for audit log):", "");
    if (!reason || !reason.trim()) return;
    setSubmitting(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/procurement/qc-findings/${f.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setFindings((ff) => ff.filter((_, i) => i !== idx));
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitSaveDraft() {
    setSubmitting(true);
    setErr(null);
    try {
      const rateNum = effectiveRate !== null && Number.isFinite(effectiveRate as number)
        ? Number(effectiveRate)
        : null;

      if (isNew) {
        const body: Record<string, unknown> = {
          receipt_id: receiptId,
          inspection_date: inspectionDate,
          inspector_employee_id: inspectorId || null,
          status: "pending",
          overall_pass_rate: rateNum,
          notes: notes.trim() || null,
        };
        const r = await fetch("/api/internal/procurement/qc-inspections", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      } else {
        const r = await fetch(`/api/internal/procurement/qc-inspections/${inspection!.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            inspector_employee_id: inspectorId || null,
            inspection_date: inspectionDate,
            overall_pass_rate: rateNum,
            notes: notes.trim() || null,
          }),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      }
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function transitionTo(next: InspectionStatus) {
    if (!inspection) return;
    setSubmitting(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/procurement/qc-inspections/${inspection.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const updated = await r.json() as InspectionRow & { auto_case_id?: string | null };
      if (updated.auto_case_id) setAutoCaseId(updated.auto_case_id);
      else if (updated.case_id) setAutoCaseId(updated.case_id);
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const transitionTargets = ALLOWED_TRANSITIONS[status] || [];
  const receipt = receipts.find((r) => r.id === receiptId);

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
          {isNew ? "New inspection" : `Edit inspection`}
          {!isNew && (
            <span style={{ marginLeft: 12, fontSize: 12, color: statusColor(status) }}>
              ● {status}
            </span>
          )}
        </h3>

        {autoCaseId && (
          <div style={{ marginBottom: 12, padding: 8, background: "#7f1d1d", color: "white", borderRadius: 6, fontSize: 13 }}>
            🚨 Case auto-linked: <span style={{ fontFamily: "SFMono-Regular, Menlo, monospace" }}>{autoCaseId}</span>
            {" "}— failed inspection with critical findings (P7-9).
          </div>
        )}

        {loading ? (
          <div style={{ color: C.textMuted, padding: 24, textAlign: "center" }}>Loading…</div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
              <Field label="Receipt">
                <SearchableSelect
                  value={receiptId || null}
                  onChange={(v) => setReceiptId(v)}
                  options={receipts.map((r) => ({ value: r.id, label: `${r.id.slice(0, 8)} — ${r.receipt_date} (${r.status})` }))}
                  placeholder="(pick receipt…)"
                  disabled={!isNew}
                />
              </Field>
              <Field label="Inspection date">
                <input type="date" value={inspectionDate} onChange={(e) => setInspectionDate(e.target.value)} disabled={!editable} style={inputStyle} />
              </Field>
              <Field label="Inspector">
                <SearchableSelect
                  value={inspectorId || null}
                  onChange={(v) => setInspectorId(v)}
                  options={[{ value: "", label: "(unassigned)" }, ...employees.map((e) => ({ value: e.id, label: e.name }))]}
                  placeholder="(unassigned)"
                  disabled={!editable}
                />
              </Field>
            </div>

            {receipt && (
              <div style={{ marginBottom: 12, padding: 8, background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 6, fontSize: 12, color: C.textSub }}>
                <strong>Receipt context:</strong> {receipt.id.slice(0, 8)}… · received {receipt.receipt_date} · status {receipt.status}
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 2fr", gap: 12, marginBottom: 12 }}>
              <Field label="Total inspected (for auto rate)">
                <input type="number" min="0" step="1" value={totalInspected} onChange={(e) => setTotalInspected(e.target.value)} disabled={!editable} style={inputStyle} placeholder="e.g. 600" />
              </Field>
              <Field label={overrideRate ? "Override pass rate (0..1)" : `Auto pass rate (computed)`}>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input type="text" value={overrideRate ? overallPassRate : (autoRate === null ? "" : autoRate.toFixed(4))} onChange={(e) => { setOverallPassRate(e.target.value); setOverrideRate(true); }} disabled={!editable} style={inputStyle} placeholder="0.0000–1.0000" />
                  <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: C.textMuted, whiteSpace: "nowrap" }}>
                    <input type="checkbox" checked={overrideRate} onChange={(e) => setOverrideRate(e.target.checked)} disabled={!editable} />
                    Override
                  </label>
                </div>
              </Field>
              <Field label="Notes">
                <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!editable} style={inputStyle} />
              </Field>
            </div>

            {/* Findings sub-section */}
            <div style={{ marginTop: 12, marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
                Findings ({findings.length})
                {findings.some((f) => f.severity === "critical") && (
                  <span style={{ marginLeft: 12, color: C.danger, textTransform: "none", letterSpacing: 0, fontSize: 12 }}>
                    ⚠ {findings.filter((f) => f.severity === "critical").length} critical
                  </span>
                )}
              </div>
              {!isNew && editable && (
                <button type="button" onClick={addFinding} style={btnSecondary}>+ Add finding</button>
              )}
            </div>

            {isNew ? (
              <div style={{ padding: 12, background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, marginBottom: 16, fontSize: 12, color: C.textMuted, fontStyle: "italic" }}>
                Save the inspection first, then add findings.
              </div>
            ) : (
              <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={{ ...th, width: 36 }}>#</th>
                      <th style={th}>Category</th>
                      <th style={{ ...th, width: 100 }}>Severity</th>
                      <th style={{ ...th, width: 90 }}>Qty affected</th>
                      <th style={th}>Description</th>
                      <th style={th}>Photo URLs</th>
                      <th style={th}>Resolution</th>
                      <th style={{ ...th, width: 110 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {findings.length === 0 ? (
                      <tr>
                        <td style={td} colSpan={8}>
                          <span style={{ color: C.textMuted, fontStyle: "italic" }}>
                            No findings yet. Click + Add finding above to record one.
                          </span>
                        </td>
                      </tr>
                    ) : findings.map((f, idx) => (
                      <tr key={f.key}>
                        <td style={td}>{idx + 1}</td>
                        <td style={td}>
                          <input type="text" value={f.category} onChange={(e) => updateFinding(idx, { category: e.target.value })} disabled={!editable} placeholder="e.g. stitching" style={inputStyle} />
                        </td>
                        <td style={td}>
                          <select value={f.severity} onChange={(e) => updateFinding(idx, { severity: e.target.value as FindingSeverity })} disabled={!editable} style={{ ...inputStyle, color: severityColor(f.severity), fontWeight: 600 }}>
                            {SEVERITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </td>
                        <td style={td}>
                          <input type="number" min="0" step="1" value={f.qty_affected} onChange={(e) => updateFinding(idx, { qty_affected: e.target.value })} disabled={!editable} style={inputStyle} />
                        </td>
                        <td style={td}>
                          <textarea value={f.description} onChange={(e) => updateFinding(idx, { description: e.target.value })} disabled={!editable} rows={2} style={{ ...inputStyle, resize: "vertical", minHeight: 32 }} />
                        </td>
                        <td style={td}>
                          <textarea value={f.photo_urls} onChange={(e) => updateFinding(idx, { photo_urls: e.target.value })} disabled={!editable} rows={2} placeholder="One URL per line (M29)" style={{ ...inputStyle, resize: "vertical", minHeight: 32, fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 11 }} />
                        </td>
                        <td style={td}>
                          <input type="text" value={f.resolution} onChange={(e) => updateFinding(idx, { resolution: e.target.value })} disabled={!editable} placeholder="e.g. vendor RMA #5512" style={inputStyle} />
                        </td>
                        <td style={td}>
                          {editable && (
                            <div style={{ display: "flex", gap: 4 }}>
                              <button type="button" onClick={() => void persistFinding(idx)} style={btnSuccess} disabled={submitting}>
                                {f.id ? "Save" : "Add"}
                              </button>
                              <button type="button" onClick={() => void removeFinding(idx)} style={btnDanger} disabled={submitting}>✕</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {!isNew && transitionTargets.length > 0 && (
              <div style={{ marginBottom: 16, padding: 12, background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>
                <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Status transitions</div>
                {transitionTargets.map((t) => (
                  <button key={t} onClick={() => void transitionTo(t)} style={{ ...(t === "failed" ? btnDanger : btnSuccess), marginRight: 6 }} disabled={submitting}>
                    {t === "passed"  ? "Mark passed"  :
                     t === "failed"  ? "Mark failed (auto-case)" :
                     t === "partial" ? "Mark partial" :
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
                <button onClick={() => void submitSaveDraft()} style={btnPrimary}
                        disabled={submitting || !receiptId}>
                  {submitting ? "Saving…" : (isNew ? "Save draft" : "Save changes")}
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
