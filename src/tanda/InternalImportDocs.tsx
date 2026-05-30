// src/tanda/InternalImportDocs.tsx
//
// Tangerine P13-6 — M48 Import Documentation panel.
//
// Lists import_documentation filtered by PO + status. "+ Add document"
// opens a modal that captures the PO (T9 SearchableSelect, filtered to
// procurement_status in {open, received}), document type (preset list of
// 5), document_url (M29 attachment URL — single text input for now),
// HS code, country of origin, declared value (cents), duty rate %,
// and status.
//
// Filters:
//  - PO SearchableSelect (T9)
//  - status (pending / received / verified / filed / all)
//  - document_type (5 presets / all)
//  - ExportButton (xlsx)
//
// Row click → detail modal with editable fields + RowHistory drop-in
// slot (T11-3 placeholder).
//
// T11 D3 — destructive DELETE prompts the operator for a reason.

import { useEffect, useMemo, useState } from "react";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import SearchableSelect from "./components/SearchableSelect";

export type DocStatus = "pending" | "received" | "verified" | "filed";

export const DOCUMENT_TYPES = [
  "commercial_invoice",
  "packing_list",
  "bill_of_lading",
  "certificate_of_origin",
  "customs_declaration",
] as const;
export type DocumentType = typeof DOCUMENT_TYPES[number];

export type ImportDocRow = {
  id: string;
  entity_id: string;
  tanda_po_id: string;
  document_type: DocumentType;
  document_url: string | null;
  hs_code: string | null;
  country_of_origin: string | null;
  declared_value_cents: number | null;
  duty_rate_pct: number | null;
  status: DocStatus;
  created_at: string;
};

type POOption = { id: string; po_number: string | null; vendor: string | null; procurement_status: string | null };

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

export const STATUS_OPTIONS: { value: DocStatus | ""; label: string }[] = [
  { value: "",         label: "All statuses" },
  { value: "pending",  label: "Pending" },
  { value: "received", label: "Received" },
  { value: "verified", label: "Verified" },
  { value: "filed",    label: "Filed" },
];

export const DOC_TYPE_OPTIONS: { value: DocumentType | ""; label: string }[] = [
  { value: "",                      label: "All types" },
  { value: "commercial_invoice",    label: "Commercial Invoice" },
  { value: "packing_list",          label: "Packing List" },
  { value: "bill_of_lading",        label: "Bill of Lading" },
  { value: "certificate_of_origin", label: "Certificate of Origin" },
  { value: "customs_declaration",   label: "Customs Declaration" },
];

export function statusColor(s: DocStatus): string {
  if (s === "filed")    return C.success;
  if (s === "verified") return C.primary;
  if (s === "received") return C.warn;
  return C.textMuted;
}

/** Format integer cents → "$X,XXX.XX". Pure — exported for tests. */
export function formatCents(c: number | null): string {
  if (c === null || c === undefined || !Number.isFinite(c)) return "—";
  const neg = c < 0;
  const abs = Math.abs(c);
  const whole = Math.trunc(abs / 100);
  const frac = abs - whole * 100;
  return `${neg ? "-" : ""}$${whole.toLocaleString()}.${String(frac).padStart(2, "0")}`;
}

export default function InternalImportDocs() {
  const [rows, setRows] = useState<ImportDocRow[]>([]);
  const [pos, setPos] = useState<POOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [poFilter, setPoFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<DocStatus | "">("");
  const [typeFilter, setTypeFilter] = useState<DocumentType | "">("");
  const [limit, setLimit] = useState(200);

  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<ImportDocRow | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams({ limit: String(limit) });
      if (poFilter) params.set("tanda_po_id", poFilter);
      if (statusFilter) params.set("status", statusFilter);
      if (typeFilter) params.set("document_type", typeFilter);
      const r = await fetch(`/api/internal/procurement/import-docs?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as ImportDocRow[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [poFilter, statusFilter, typeFilter, limit]);

  useEffect(() => {
    fetch("/api/internal/procurement/pos?status=open&limit=500")
      .then((r) => r.json())
      .then((arr: unknown) => { if (Array.isArray(arr)) setPos(arr as POOption[]); })
      .catch(() => {});
    // Also pull 'received' POs (the spec's "open or received" filter set).
    fetch("/api/internal/procurement/pos?status=received&limit=500&include_terminal=true")
      .then((r) => r.json())
      .then((arr: unknown) => {
        if (Array.isArray(arr)) {
          setPos((prev) => {
            const seen = new Set(prev.map((p) => p.id));
            return [...prev, ...(arr as POOption[]).filter((p) => !seen.has(p.id))];
          });
        }
      })
      .catch(() => {});
  }, []);

  const poMap = useMemo(() => {
    const m: Record<string, POOption> = {};
    for (const p of pos) m[p.id] = p;
    return m;
  }, [pos]);

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>📦 Procurement — Import Documentation</h2>
        <button onClick={() => { setEditing(null); setEditOpen(true); }} style={btnPrimary}>
          + Add document
        </button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ width: 320 }}>
          <SearchableSelect
            value={poFilter || null}
            onChange={(v) => setPoFilter(v)}
            options={[{ value: "", label: "All POs" }, ...pos.map((p) => ({
              value: p.id,
              label: `${p.po_number || p.id.slice(0, 8)} — ${p.vendor || ""}`,
            }))]}
            placeholder="All POs"
          />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as DocStatus | "")} style={{ ...inputStyle, width: 180 }}>
          {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as DocumentType | "")} style={{ ...inputStyle, width: 220 }}>
          {DOC_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} style={{ ...inputStyle, width: 110 }}>
          <option value={50}>Limit 50</option>
          <option value={100}>Limit 100</option>
          <option value={200}>Limit 200</option>
          <option value={500}>Limit 500</option>
        </select>
        <button onClick={() => void load()} style={btnSecondary}>Search</button>
        <ExportButton
          rows={rows.map((r) => ({
            id: r.id,
            po: poMap[r.tanda_po_id]?.po_number || r.tanda_po_id,
            document_type: r.document_type,
            status: r.status,
            hs_code: r.hs_code,
            country_of_origin: r.country_of_origin,
            declared_value_cents: r.declared_value_cents,
            duty_rate_pct: r.duty_rate_pct,
            document_url: r.document_url,
          })) as unknown as Array<Record<string, unknown>>}
          filename="import-documentation"
          sheetName="Import Docs"
          columns={[
            { key: "id",                   header: "Doc ID" },
            { key: "po",                   header: "PO" },
            { key: "document_type",        header: "Type" },
            { key: "status",               header: "Status" },
            { key: "hs_code",              header: "HS Code" },
            { key: "country_of_origin",    header: "COO" },
            { key: "declared_value_cents", header: "Declared Value (cents)" },
            { key: "duty_rate_pct",        header: "Duty %" },
            { key: "document_url",         header: "Document URL" },
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
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No import documents.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>PO</th>
                <th style={th}>Type</th>
                <th style={th}>HS</th>
                <th style={th}>COO</th>
                <th style={{ ...th, textAlign: "right" }}>Declared</th>
                <th style={{ ...th, textAlign: "right" }}>Duty %</th>
                <th style={th}>Status</th>
                <th style={th}>Doc</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} onClick={() => { setEditing(r); setEditOpen(true); }} style={{ cursor: "pointer" }}>
                  <td style={td}>{poMap[r.tanda_po_id]?.po_number || r.tanda_po_id.slice(0, 12) + "…"}</td>
                  <td style={td}>{r.document_type}</td>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }}>{r.hs_code || "—"}</td>
                  <td style={td}>{r.country_of_origin || "—"}</td>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", textAlign: "right" }}>
                    {formatCents(r.declared_value_cents)}
                  </td>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", textAlign: "right" }}>
                    {r.duty_rate_pct === null ? "—" : `${r.duty_rate_pct}%`}
                  </td>
                  <td style={td}>
                    <span style={{ color: statusColor(r.status), fontWeight: 600 }}>● {r.status}</span>
                  </td>
                  <td style={td}>
                    {r.document_url
                      ? <a href={r.document_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: C.primary, fontSize: 11 }}>open</a>
                      : <span style={{ color: C.textMuted }}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editOpen && (
        <ImportDocModal
          doc={editing}
          pos={pos}
          onClose={() => { setEditOpen(false); setEditing(null); }}
          onSaved={() => { setEditOpen(false); setEditing(null); void load(); }}
        />
      )}

      <div style={{ marginTop: 16, padding: 12, background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, fontSize: 11, color: C.textMuted }}>
        Audit log surfaces here once T11-3 RowHistory drop-in ships
        (source_table='import_documentation').
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Import doc modal — new + edit + delete-with-reason (T11 D3)
// ─────────────────────────────────────────────────────────────────────

export function ImportDocModal({
  doc, pos, onClose, onSaved,
}: {
  doc: ImportDocRow | null;
  pos: POOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = doc === null;

  const [poId, setPoId]                       = useState<string>(doc?.tanda_po_id || "");
  const [docType, setDocType]                 = useState<DocumentType>(doc?.document_type || "commercial_invoice");
  const [documentUrl, setDocumentUrl]         = useState<string>(doc?.document_url || "");
  const [hsCode, setHsCode]                   = useState<string>(doc?.hs_code || "");
  const [countryOfOrigin, setCountryOfOrigin] = useState<string>(doc?.country_of_origin || "");
  const [declaredCents, setDeclaredCents]     = useState<string>(
    doc?.declared_value_cents !== null && doc?.declared_value_cents !== undefined
      ? String(doc.declared_value_cents)
      : "",
  );
  const [dutyPct, setDutyPct] = useState<string>(
    doc?.duty_rate_pct !== null && doc?.duty_rate_pct !== undefined
      ? String(doc.duty_rate_pct)
      : "",
  );
  const [status, setStatus] = useState<DocStatus>(doc?.status || "pending");

  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        tanda_po_id: poId,
        document_type: docType,
        document_url: documentUrl.trim() || null,
        hs_code: hsCode.trim() || null,
        country_of_origin: countryOfOrigin.trim() || null,
        declared_value_cents: declaredCents.trim() === "" ? null : parseInt(declaredCents, 10),
        duty_rate_pct: dutyPct.trim() === "" ? null : parseFloat(dutyPct),
        status,
      };
      let r: Response;
      if (isNew) {
        r = await fetch("/api/internal/procurement/import-docs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        r = await fetch(`/api/internal/procurement/import-docs/${doc!.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
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

  async function destroy() {
    if (!doc) return;
    const reason = prompt("Delete reason (required for audit log):", "");
    if (!reason || !reason.trim()) return;
    setSubmitting(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/procurement/import-docs/${doc.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
      display: "flex", alignItems: "flex-start", justifyContent: "center",
      zIndex: 100, paddingTop: 40, paddingBottom: 40, overflowY: "auto",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10,
        padding: 20, width: 760, maxWidth: "95vw", color: C.text,
      }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {isNew ? "Add import document" : "Edit import document"}
          {!isNew && (
            <span style={{ marginLeft: 12, fontSize: 12, color: statusColor(status) }}>● {status}</span>
          )}
        </h3>

        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="PO">
            <SearchableSelect
              value={poId || null}
              onChange={(v) => setPoId(v)}
              options={pos.map((p) => ({
                value: p.id,
                label: `${p.po_number || p.id.slice(0, 8)} — ${p.vendor || ""} (${p.procurement_status || "?"})`,
              }))}
              placeholder="(pick PO…)"
              disabled={!isNew}
            />
          </Field>
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value as DocStatus)} style={{ ...inputStyle, color: statusColor(status), fontWeight: 600 }}>
              {(["pending", "received", "verified", "filed"] as const).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </Field>
        </div>

        <div style={{ marginBottom: 12 }}>
          <Field label="Document type">
            <select value={docType} onChange={(e) => setDocType(e.target.value as DocumentType)} style={inputStyle} disabled={!isNew}>
              {DOCUMENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="HS code">
            <input type="text" value={hsCode} onChange={(e) => setHsCode(e.target.value)} style={inputStyle} placeholder="e.g. 6109.10.0040" />
          </Field>
          <Field label="Country of origin">
            <input type="text" value={countryOfOrigin} onChange={(e) => setCountryOfOrigin(e.target.value)} style={inputStyle} placeholder="e.g. CN / China" />
          </Field>
          <Field label="Declared value (cents)">
            <input type="number" min="0" step="1" value={declaredCents} onChange={(e) => setDeclaredCents(e.target.value)} style={inputStyle} placeholder="e.g. 2700000" />
          </Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12, marginBottom: 12 }}>
          <Field label="Duty rate %">
            <input type="number" min="0" max="100" step="0.0001" value={dutyPct} onChange={(e) => setDutyPct(e.target.value)} style={inputStyle} placeholder="e.g. 7.5" />
          </Field>
          <Field label="Document URL (M29 attachment)">
            <input
              type="url"
              value={documentUrl}
              onChange={(e) => setDocumentUrl(e.target.value)}
              style={{ ...inputStyle, fontFamily: "SFMono-Regular, Menlo, monospace" }}
              placeholder="https://…"
            />
          </Field>
        </div>

        {err && (
          <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <div>
            {!isNew && (
              <button onClick={() => void destroy()} style={btnDanger} disabled={submitting}>
                Delete (with reason)
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} style={btnSecondary} disabled={submitting}>Close</button>
            <button onClick={() => void submit()} style={btnPrimary} disabled={submitting || !poId}>
              {submitting ? "Saving…" : (isNew ? "Save" : "Save changes")}
            </button>
          </div>
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
