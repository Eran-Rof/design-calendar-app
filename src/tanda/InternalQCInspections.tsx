// src/tanda/InternalQCInspections.tsx
//
// P13-C2 — QC Inspections vertical. Quality-control inspections recorded
// against a POSTED goods-receipt (tanda_po_receipts). List + create/edit modal
// recording inspection status, an optional pass rate, and per-finding rows
// (category / severity / qty affected / description).
//
// FINANCIALLY INERT: records inspection results only. The disposition workflow
// (vendor RMA / credit / write-off / rework) and its GL/AP posting is a FUTURE
// chunk — surfaced here as a read-only note.
//
// Mirrors InternalReceiving.tsx conventions (C palette, th/td/input/button
// styles, SearchableSelect, notify, Field helper, mandatory ExportButton).

import { useEffect, useMemo, useState } from "react";
import SearchableSelect from "./components/SearchableSelect";
import { notify } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2 };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const inputStyle: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box", colorScheme: "dark" };
const numInputStyle: React.CSSProperties = { ...inputStyle, width: "8ch", textAlign: "right" };
const btnPrimary: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const btnDanger: React.CSSProperties = { ...btnSecondary, color: C.danger, borderColor: "#7f1d1d", padding: "2px 8px" };

type Inspection = {
  id: string; receipt_id: string; inspection_date: string;
  inspector_employee_id: string | null; status: string;
  overall_pass_rate: number | string | null; notes: string | null;
  receipt?: { id: string; purchase_order_id: string | null; receipt_date: string | null } | null;
  findings_count?: number;
};
type Receipt = { id: string; purchase_order_id: string | null; receipt_date: string; status: string; purchase_order?: { po_number: string | null } | null };
type Disp = { id: string; disposition: string; qty: number; reason: string; je_id: string | null; status: string };
type ReceiptLine = { id: string; qty_accepted: number | string; purchase_order_line?: { description: string | null; inventory_item_id: string | null } | null };
type PO = { id: string; po_number: string | null };
type Employee = { id: string; name?: string; full_name?: string; first_name?: string; last_name?: string };
type Finding = { id?: string; category: string; severity: string; qty_affected: number | string; description: string; resolution: string | null };

// A single editable finding row in the modal.
type FRow = { key: number; category: string; severity: string; qty_affected: string; description: string; resolution: string };

const QC_STATUSES = ["pending", "passed", "failed", "partial"];
const SEVERITIES = ["minor", "major", "critical"];
const STATUS_COLORS: Record<string, string> = {
  pending: C.textMuted, passed: C.success, failed: C.danger, partial: C.warn,
};

function fmtPct(r: number | string | null | undefined): string {
  if (r == null || r === "") return "—";
  const n = Number(r);
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(2)}%`;
}
function poNumberFor(rec: Inspection["receipt"], poById: Map<string, PO>): string {
  if (!rec) return "(no receipt)";
  if (rec.purchase_order_id) {
    const po = poById.get(rec.purchase_order_id);
    if (po?.po_number) return po.po_number;
  }
  return rec.receipt_date ? `Receipt — ${rec.receipt_date}` : "(no PO #)";
}
function employeeName(e: Employee): string {
  return e.name || e.full_name || [e.first_name, e.last_name].filter(Boolean).join(" ") || "(unnamed)";
}

const EXPORT_COLUMNS: ExportColumn<Record<string, unknown>>[] = [
  { key: "po_number", header: "PO / receipt" },
  { key: "inspection_date", header: "Inspection date", format: "date" },
  { key: "status", header: "Status" },
  { key: "findings_count", header: "Findings", format: "number" },
  { key: "pass_rate", header: "Pass rate" },
];

export default function InternalQCInspections() {
  const [rows, setRows] = useState<Inspection[]>([]);
  const [pos, setPos] = useState<PO[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Inspection | null>(null);

  const poById = useMemo(() => new Map(pos.map((p) => [p.id, p])), [pos]);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      const r = await fetch(`/api/internal/procurement/qc?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as Inspection[]);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [statusFilter]);

  // PO numbers for display (the GET embeds purchase_order_id, not po_number).
  useEffect(() => {
    fetch("/api/internal/purchase-orders?limit=1000").then((r) => r.ok ? r.json() : []).then((a) => {
      setPos(Array.isArray(a) ? a as PO[] : []);
    }).catch(() => {});
  }, []);

  const exportRows = useMemo(() => rows.map((r) => ({
    po_number: poNumberFor(r.receipt, poById),
    inspection_date: r.inspection_date,
    status: r.status,
    findings_count: r.findings_count ?? 0,
    pass_rate: fmtPct(r.overall_pass_rate),
  })), [rows, poById]);

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>QC Inspections</h2>
        <button style={btnPrimary} onClick={() => { setEditing(null); setModalOpen(true); }}>+ New inspection</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ width: 200 }}>
          <SearchableSelect
            value={statusFilter || null}
            onChange={(v) => setStatusFilter(v)}
            options={[
              { value: "", label: "All statuses" },
              ...QC_STATUSES.map((s) => ({ value: s, label: s })),
            ]}
            placeholder="All statuses"
            inputStyle={inputStyle}
          />
        </div>
        <button style={btnSecondary} onClick={() => void load()}>Refresh</button>
        <ExportButton rows={exportRows} columns={EXPORT_COLUMNS} filename="qc-inspections" sheetName="QC Inspections" />
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th style={th}>Receipt / PO #</th><th style={th}>Inspection date</th><th style={th}>Status</th>
            <th style={{ ...th, textAlign: "right" }}>Findings</th><th style={{ ...th, textAlign: "right" }}>Pass rate</th>
          </tr></thead>
          <tbody>
            {loading && <tr><td style={td} colSpan={5}>Loading…</td></tr>}
            {!loading && rows.length === 0 && <tr><td style={{ ...td, color: C.textMuted }} colSpan={5}>No inspections.</td></tr>}
            {rows.map((r) => (
              <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => { setEditing(r); setModalOpen(true); }}>
                <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }}>{poNumberFor(r.receipt, poById)}</td>
                <td style={td}>{r.inspection_date}</td>
                <td style={td}><span style={{ color: STATUS_COLORS[r.status] || C.text, fontWeight: 600 }}>● {r.status}</span></td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.findings_count ?? 0}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtPct(r.overall_pass_rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modalOpen && (
        <InspectionModal
          inspection={editing}
          pos={pos}
          onClose={() => { setModalOpen(false); setEditing(null); }}
          onSaved={() => { setModalOpen(false); setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

function InspectionModal({ inspection, pos, onClose, onSaved }: { inspection: Inspection | null; pos: PO[]; onClose: () => void; onSaved: () => void }) {
  const isNew = inspection === null;

  const [savedId, setSavedId] = useState<string | null>(inspection?.id || null);
  const [receiptId, setReceiptId] = useState(inspection?.receipt_id || "");
  const [inspectionDate, setInspectionDate] = useState(inspection?.inspection_date || new Date().toISOString().slice(0, 10));
  const [inspectorId, setInspectorId] = useState(inspection?.inspector_employee_id || "");
  const [status, setStatus] = useState(inspection?.status || "pending");
  const [passRate, setPassRate] = useState(inspection?.overall_pass_rate != null && inspection?.overall_pass_rate !== "" ? (Number(inspection.overall_pass_rate) * 100).toFixed(2) : "");
  const [notes, setNotes] = useState(inspection?.notes || "");
  const [findings, setFindings] = useState<FRow[]>([]);
  const [dispositions, setDispositions] = useState<Disp[]>([]);
  const [dispOpen, setDispOpen] = useState(false);

  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const poById = useMemo(() => new Map(pos.map((p) => [p.id, p])), [pos]);

  // Load POSTED receipts (to pick from) + employees (inspector picker).
  useEffect(() => {
    fetch("/api/internal/procurement/receipts?status=posted&limit=500").then((r) => r.ok ? r.json() : []).then((a) => {
      setReceipts(Array.isArray(a) ? a as Receipt[] : []);
    }).catch(() => {});
    fetch("/api/internal/employees?limit=1000").then((r) => r.ok ? r.json() : []).then((a) => {
      setEmployees(Array.isArray(a) ? a as Employee[] : []);
    }).catch(() => {});
  }, []);

  // Load an existing inspection's findings when editing.
  useEffect(() => {
    if (isNew || !inspection) return;
    fetch(`/api/internal/procurement/qc/${inspection.id}`).then((r) => r.ok ? r.json() : null).then((full) => {
      if (!full || !Array.isArray(full.findings)) return;
      setFindings(full.findings.map((f: Finding, i: number) => ({
        key: i + 1,
        category: f.category || "",
        severity: f.severity || "minor",
        qty_affected: String(f.qty_affected ?? 0),
        description: f.description || "",
        resolution: f.resolution || "",
      })));
    }).catch(() => {});
    void loadDispositions();
  }, [isNew, inspection]);

  function loadDispositions() {
    if (!savedId) return Promise.resolve();
    return fetch(`/api/internal/procurement/qc/dispositions?inspection_id=${savedId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((a) => setDispositions(Array.isArray(a) ? a as Disp[] : []))
      .catch(() => {});
  }

  function addFinding() { setFindings((p) => [...p, { key: (p[p.length - 1]?.key ?? 0) + 1, category: "", severity: "minor", qty_affected: "0", description: "", resolution: "" }]); }
  function updateFinding(idx: number, patch: Partial<FRow>) { setFindings((p) => p.map((f, i) => i === idx ? { ...f, ...patch } : f)); }
  function removeFinding(idx: number) { setFindings((p) => p.filter((_, i) => i !== idx)); }

  function receiptLabel(r: Receipt): string {
    const po = r.purchase_order_id ? poById.get(r.purchase_order_id) : null;
    const poNum = r.purchase_order?.po_number || po?.po_number || "(no PO #)";
    return `${poNum} — ${r.receipt_date}`;
  }

  function apiFindings() {
    return findings
      .filter((f) => f.category.trim() && f.description.trim())
      .map((f) => ({
        category: f.category.trim(),
        severity: f.severity,
        qty_affected: f.qty_affected === "" ? 0 : Number(f.qty_affected),
        description: f.description.trim(),
        resolution: f.resolution.trim() || null,
      }));
  }

  // overall_pass_rate as a 0..1 fraction, or null when blank.
  function passRateFraction(): number | null {
    if (passRate.trim() === "") return null;
    const n = Number(passRate);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(1, n / 100));
  }

  async function save(): Promise<string | null> {
    setErr(null);
    if (!receiptId) { setErr("Pick a posted receipt to inspect."); return null; }
    setSubmitting(true);
    try {
      let id = savedId;
      if (!id) {
        const body = {
          receipt_id: receiptId,
          inspection_date: inspectionDate,
          inspector_employee_id: inspectorId || null,
          status,
          notes: notes.trim() || null,
          findings: apiFindings(),
        };
        const r = await fetch("/api/internal/procurement/qc", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        id = j?.id || null;
        setSavedId(id);
        // The POST does not derive pass rate from the % field; PATCH it if set.
        const frac = passRateFraction();
        if (id && frac != null) {
          await fetch(`/api/internal/procurement/qc/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ overall_pass_rate: frac }) });
        }
      } else {
        const body = {
          status,
          inspection_date: inspectionDate,
          inspector_employee_id: inspectorId || null,
          notes: notes.trim() || null,
          overall_pass_rate: passRateFraction(),
          findings: apiFindings(),
        };
        const r = await fetch(`/api/internal/procurement/qc/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      }
      return id;
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); return null; }
    finally { setSubmitting(false); }
  }

  async function saveInspection() {
    const id = await save();
    if (id) { notify("QC inspection saved.", "success"); onSaved(); }
  }

  async function deleteInspection() {
    if (!savedId) return;
    setSubmitting(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/procurement/qc/${savedId}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      notify("QC inspection deleted.", "success");
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }

  const headerLabel = isNew
    ? "New inspection"
    : `Inspection — ${poNumberFor(inspection?.receipt, poById)} — ${inspection?.status}`;

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(1180px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>{headerLabel}</h3>

        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Posted receipt to inspect">
            <SearchableSelect value={receiptId || null} onChange={(v) => setReceiptId(v)}
              options={[{ value: "", label: "(pick a posted receipt…)" }, ...receipts.map((r) => ({ value: r.id, label: receiptLabel(r), searchHaystack: receiptLabel(r) }))]}
              placeholder="(pick a posted receipt…)" disabled={!isNew} />
          </Field>
          <Field label="Inspection date"><input type="date" value={inspectionDate} onChange={(e) => setInspectionDate(e.target.value)} style={inputStyle} /></Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Inspector">
            <SearchableSelect value={inspectorId || null} onChange={(v) => setInspectorId(v)}
              options={[{ value: "", label: "(inspector — optional)" }, ...employees.map((e) => ({ value: e.id, label: employeeName(e), searchHaystack: employeeName(e) }))]}
              placeholder="(inspector — optional)" />
          </Field>
          <Field label="Status">
            <SearchableSelect
              value={status || null}
              onChange={(v) => setStatus(v)}
              options={QC_STATUSES.map((s) => ({ value: s, label: s }))}
              inputStyle={inputStyle}
            />
          </Field>
          <Field label="Overall pass rate (%)"><input type="text" inputMode="decimal" value={passRate} onChange={(e) => setPassRate(e.target.value)} placeholder="e.g. 98.34" style={inputStyle} /></Field>
        </div>

        <Field label="Notes"><input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} style={inputStyle} placeholder="optional" /></Field>

        {/* Findings — one row per defect category. */}
        <div style={{ marginTop: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Findings</div>
            <button onClick={addFinding} style={btnSecondary}>+ Add finding</button>
          </div>
          <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
              <colgroup><col style={{ width: 36 }} /><col style={{ width: 180 }} /><col style={{ width: 120 }} /><col style={{ width: 90 }} /><col /><col style={{ width: 40 }} /></colgroup>
              <thead><tr>
                <th style={th}>#</th><th style={th}>Category</th><th style={th}>Severity</th><th style={{ ...th, textAlign: "right" }}>Qty</th><th style={th}>Description</th><th style={th}></th>
              </tr></thead>
              <tbody>
                {findings.length === 0 && <tr><td style={{ ...td, color: C.textMuted }} colSpan={6}>No findings. Add defect categories (e.g. seam_integrity) as needed.</td></tr>}
                {findings.map((f, idx) => (
                  <tr key={f.key}>
                    <td style={td}>{idx + 1}</td>
                    <td style={td}><input type="text" value={f.category} onChange={(e) => updateFinding(idx, { category: e.target.value })} placeholder="e.g. seam_integrity" style={inputStyle} /></td>
                    <td style={td}>
                      <SearchableSelect
                        value={f.severity || null}
                        onChange={(v) => updateFinding(idx, { severity: v })}
                        options={SEVERITIES.map((s) => ({ value: s, label: s }))}
                        inputStyle={inputStyle}
                      />
                    </td>
                    <td style={td}><input type="text" inputMode="decimal" value={f.qty_affected} onChange={(e) => updateFinding(idx, { qty_affected: e.target.value })} placeholder="0" style={numInputStyle} /></td>
                    <td style={td}><input type="text" value={f.description} onChange={(e) => updateFinding(idx, { description: e.target.value })} placeholder="defect description" style={inputStyle} /></td>
                    <td style={td}><button type="button" onClick={() => removeFinding(idx)} style={btnDanger}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Dispositions — act on a QC fail with its GL effect. */}
        {savedId && receiptId && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Dispositions</div>
              <button onClick={() => setDispOpen(true)} style={btnSecondary}>Record disposition</button>
            </div>
            {dispositions.length === 0 ? (
              <div style={{ fontSize: 12, color: C.textMuted }}>
                None yet. <b>Write-off</b> posts DR Inventory Write-off (6420) / CR Inventory; <b>vendor credit</b> posts DR AP / CR Inventory + a credit memo; <b>RMA</b> &amp; <b>rework</b> are recorded only.
              </div>
            ) : (
              <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", fontSize: 12 }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr><th style={th}>Disposition</th><th style={{ ...th, textAlign: "right" }}>Qty</th><th style={th}>Reason</th><th style={th}>GL</th></tr></thead>
                  <tbody>{dispositions.map((d) => (
                    <tr key={d.id}>
                      <td style={td}>{d.disposition}</td>
                      <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{d.qty}</td>
                      <td style={td}>{d.reason}</td>
                      <td style={td}>{d.je_id ? <span style={{ color: C.success }}>posted</span> : d.status}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

        {/* Sticky action footer — pinned to the bottom of the scrolling modal so
            Save / Close stay reachable as the inspection checklist grows. */}
        <div style={{ position: "sticky", bottom: -20, zIndex: 3, background: C.card, borderTop: `1px solid ${C.cardBdr}`, margin: "0 -20px -20px", padding: "12px 20px", display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
          <div>
            {savedId && <button onClick={() => void deleteInspection()} style={btnDanger} disabled={submitting}>Delete</button>}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button onClick={onClose} style={btnSecondary} disabled={submitting}>Close</button>
            <button onClick={() => void saveInspection()} style={btnPrimary} disabled={submitting}>{submitting ? "Saving…" : (savedId ? "Save inspection" : "Create inspection")}</button>
          </div>
        </div>
      </div>
      {dispOpen && savedId && (
        <DispositionModal
          inspectionId={savedId}
          receiptId={receiptId}
          onClose={() => setDispOpen(false)}
          onPosted={() => { setDispOpen(false); void loadDispositions(); }}
        />
      )}
    </div>
  );
}

const DISPOSITIONS = [
  { value: "write_off", label: "Write-off (DR 6420 / CR Inventory)" },
  { value: "vendor_credit_only", label: "Vendor credit (DR AP / CR Inventory)" },
  { value: "vendor_rma", label: "Vendor RMA (record only)" },
  { value: "rework_inhouse", label: "Rework in-house (record only)" },
];

function DispositionModal({ inspectionId, receiptId, onClose, onPosted }: { inspectionId: string; receiptId: string; onClose: () => void; onPosted: () => void }) {
  const [lines, setLines] = useState<ReceiptLine[]>([]);
  const [receiptLineId, setReceiptLineId] = useState("");
  const [disposition, setDisposition] = useState("write_off");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/internal/procurement/receipts/${receiptId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((full) => setLines(full && Array.isArray(full.lines) ? full.lines as ReceiptLine[] : []))
      .catch(() => {});
  }, [receiptId]);

  async function post() {
    if (!receiptLineId) { setErr("Pick the receipt line (SKU) being disposed."); return; }
    const q = Math.round(Number(qty));
    if (!Number.isFinite(q) || q <= 0) { setErr("Qty must be a positive integer."); return; }
    if (!reason.trim()) { setErr("A reason is required."); return; }
    setSubmitting(true); setErr(null);
    try {
      const r = await fetch("/api/internal/procurement/qc/dispositions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspection_id: inspectionId, receipt_line_id: receiptLineId, disposition, qty: q, reason: reason.trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      notify("Disposition recorded.", "success");
      onPosted();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }

  function lineLabel(l: ReceiptLine): string {
    const desc = l.purchase_order_line?.description || "(no description)";
    return `${desc} · accepted ${l.qty_accepted}`;
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 110 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(560px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        <h3 style={{ margin: "0 0 8px", fontSize: 18 }}>Record disposition</h3>
        <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14 }}>
          Write-off and vendor-credit post a journal entry immediately and draw the units from FIFO stock; RMA and rework are recorded only.
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          <Field label="Receipt line (SKU)">
            <SearchableSelect
              value={receiptLineId || null}
              onChange={(v) => setReceiptLineId(v)}
              options={[
                { value: "", label: "— pick a line —" },
                ...lines.map((l) => ({ value: l.id, label: lineLabel(l), searchHaystack: lineLabel(l) })),
              ]}
              placeholder="— pick a line —"
              inputStyle={inputStyle}
            />
          </Field>
          <Field label="Disposition">
            <SearchableSelect
              value={disposition || null}
              onChange={(v) => setDisposition(v)}
              options={DISPOSITIONS.map((d) => ({ value: d.value, label: d.label }))}
              inputStyle={inputStyle}
            />
          </Field>
          <Field label="Qty"><input type="text" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="units" style={inputStyle} /></Field>
          <Field label="Reason"><input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="why these units failed" style={inputStyle} /></Field>
        </div>
        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, margin: "12px 0", fontSize: 13 }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={() => void post()} style={btnPrimary} disabled={submitting}>{submitting ? "Recording…" : "Record disposition"}</button>
        </div>
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
