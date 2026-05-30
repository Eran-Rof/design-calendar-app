// src/tanda/InternalVendorCompliance.tsx
//
// Tangerine P13-6 — M48 Vendor Compliance Certifications panel.
//
// Lists vendor_compliance_certifications filtered by status (default
// 'active'). "+ Add certification" opens a modal that captures vendor
// (T9 SearchableSelect), certification_type (preset list + 'custom' with
// free-text fallback), cert_number, issued_at, expires_at, document_url
// (M29 attachment URL — single text input for now; will swap to a real
// upload widget once the M29 component lands), and status.
//
// Filters:
//  - status (active / expired / revoked / pending / all-inactive)
//  - vendor SearchableSelect (T9)
//  - DateRangePresets (T7) — applied to expires_at
//  - "Expiring soon" chip — toggles a 60-day expires_at window
//  - ExportButton (xlsx)
//
// Row click → detail modal with editable fields + RowHistory drop-in slot
// (T11-3 placeholder for now).
//
// T11 D3 — destructive DELETE prompts the operator for a reason; the
// reason flows into the request body for the audit-log trigger.

import { useEffect, useMemo, useState } from "react";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import SearchableSelect from "./components/SearchableSelect";
import DateRangePresets from "./components/DateRangePresets.tsx";

export type CertStatus = "active" | "expired" | "revoked" | "pending";

export const PRESET_CERT_TYPES = ["OEKO-TEX", "GOTS", "BSCI", "WRAP", "ISO9001", "custom"] as const;
export type PresetCertType = typeof PRESET_CERT_TYPES[number];

export type CertRow = {
  id: string;
  entity_id: string;
  vendor_id: string;
  certification_type: string;
  cert_number: string | null;
  issued_at: string | null;
  expires_at: string | null;
  document_url: string | null;
  status: CertStatus;
  created_at: string;
};

type Vendor = { id: string; name: string };

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
const btnChipActive: React.CSSProperties = { ...btnSecondary, background: "#172554", color: "#bfdbfe", borderColor: "#1d4ed8" };

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

export const STATUS_OPTIONS: { value: CertStatus | ""; label: string }[] = [
  { value: "",        label: "Active (default)" },
  { value: "active",  label: "Active" },
  { value: "expired", label: "Expired" },
  { value: "revoked", label: "Revoked" },
  { value: "pending", label: "Pending" },
];

export function statusColor(s: CertStatus): string {
  if (s === "active")  return C.success;
  if (s === "expired") return C.danger;
  if (s === "revoked") return C.warn;
  return C.textMuted;
}

/** Pure: derive UI "expiring soon" badge for a row.
 * Returns 'critical' (≤30d / past), 'warn' (≤60d) or null.
 */
export function expiringBadge(expiresAt: string | null, today: string): "critical" | "warn" | null {
  if (!expiresAt) return null;
  const exp = new Date(expiresAt + "T00:00:00Z").getTime();
  const now = new Date(today + "T00:00:00Z").getTime();
  if (!Number.isFinite(exp) || !Number.isFinite(now)) return null;
  const days = Math.floor((exp - now) / 86_400_000);
  if (days <= 30) return "critical";
  if (days <= 60) return "warn";
  return null;
}

export default function InternalVendorCompliance() {
  const [rows, setRows] = useState<CertRow[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<CertStatus | "">("");
  const [vendorFilter, setVendorFilter] = useState<string>("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [expiringSoon, setExpiringSoon] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [limit, setLimit] = useState(200);

  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<CertRow | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams({ limit: String(limit) });
      if (statusFilter) params.set("status", statusFilter);
      if (vendorFilter) params.set("vendor_id", vendorFilter);
      if (fromDate) params.set("from", fromDate);
      if (toDate) params.set("to", toDate);
      if (expiringSoon) params.set("expiring_within_days", "60");
      if (includeInactive) params.set("include_inactive", "true");
      const r = await fetch(`/api/internal/procurement/compliance-certs?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as CertRow[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [statusFilter, vendorFilter, expiringSoon, includeInactive, fromDate, toDate, limit]);

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

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>📦 Procurement — Vendor Compliance</h2>
        <button onClick={() => { setEditing(null); setEditOpen(true); }} style={btnPrimary}>
          + Add certification
        </button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as CertStatus | "")} style={{ ...inputStyle, width: 200 }}>
          {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <div style={{ width: 280 }}>
          <SearchableSelect
            value={vendorFilter || null}
            onChange={(v) => setVendorFilter(v)}
            options={[{ value: "", label: "All vendors" }, ...vendors.map((v) => ({ value: v.id, label: v.name }))]}
            placeholder="All vendors"
          />
        </div>
        <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={{ ...inputStyle, width: 140 }} />
        <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={{ ...inputStyle, width: 140 }} />
        <DateRangePresets from={fromDate} to={toDate} onChange={(f, t) => { setFromDate(f); setToDate(t); }} />
        <button
          type="button"
          onClick={() => setExpiringSoon((s) => !s)}
          style={expiringSoon ? btnChipActive : btnSecondary}
          data-testid="expiring-soon-chip"
        >
          ⚠ Expiring soon (60d)
        </button>
        <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} style={{ ...inputStyle, width: 110 }}>
          <option value={50}>Limit 50</option>
          <option value={100}>Limit 100</option>
          <option value={200}>Limit 200</option>
          <option value={500}>Limit 500</option>
        </select>
        <button onClick={() => void load()} style={btnSecondary}>Search</button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          Include inactive
        </label>
        <ExportButton
          rows={rows.map((r) => ({
            id: r.id,
            vendor: vendorMap[r.vendor_id]?.name || r.vendor_id,
            certification_type: r.certification_type,
            cert_number: r.cert_number,
            issued_at: r.issued_at,
            expires_at: r.expires_at,
            status: r.status,
            document_url: r.document_url,
          })) as unknown as Array<Record<string, unknown>>}
          filename="vendor-compliance-certifications"
          sheetName="Vendor Certs"
          columns={[
            { key: "id",                 header: "Cert ID" },
            { key: "vendor",             header: "Vendor" },
            { key: "certification_type", header: "Type" },
            { key: "cert_number",        header: "Cert #" },
            { key: "issued_at",          header: "Issued",  format: "date" },
            { key: "expires_at",         header: "Expires", format: "date" },
            { key: "status",             header: "Status" },
            { key: "document_url",       header: "Document URL" },
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
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No certifications.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Vendor</th>
                <th style={th}>Type</th>
                <th style={th}>Cert #</th>
                <th style={th}>Issued</th>
                <th style={th}>Expires</th>
                <th style={th}>Status</th>
                <th style={th}>Doc</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const badge = expiringBadge(r.expires_at, today);
                return (
                  <tr key={r.id} onClick={() => { setEditing(r); setEditOpen(true); }} style={{ cursor: "pointer" }}>
                    <td style={td}>{vendorMap[r.vendor_id]?.name || r.vendor_id.slice(0, 12) + "…"}</td>
                    <td style={td}>{r.certification_type}</td>
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }}>{r.cert_number || "—"}</td>
                    <td style={td}>{r.issued_at || "—"}</td>
                    <td style={td}>
                      {r.expires_at || "—"}
                      {badge === "critical" && <span style={{ marginLeft: 8, color: C.danger, fontWeight: 600 }}>⚠ ≤30d</span>}
                      {badge === "warn"     && <span style={{ marginLeft: 8, color: C.warn,   fontWeight: 600 }}>⚠ ≤60d</span>}
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
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {editOpen && (
        <CertModal
          cert={editing}
          vendors={vendors}
          onClose={() => { setEditOpen(false); setEditing(null); }}
          onSaved={() => { setEditOpen(false); setEditing(null); void load(); }}
        />
      )}

      <div style={{ marginTop: 16, padding: 12, background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, fontSize: 11, color: C.textMuted }}>
        Audit log surfaces here once T11-3 RowHistory drop-in ships
        (source_table='vendor_compliance_certifications').
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Cert modal — new + edit + delete-with-reason (T11 D3)
// ─────────────────────────────────────────────────────────────────────

export function CertModal({
  cert, vendors, onClose, onSaved,
}: {
  cert: CertRow | null;
  vendors: Vendor[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = cert === null;

  const initialPreset = isNew
    ? "OEKO-TEX"
    : PRESET_CERT_TYPES.includes(cert!.certification_type as PresetCertType)
      ? cert!.certification_type as PresetCertType
      : "custom";

  const [vendorId, setVendorId] = useState<string>(cert?.vendor_id || "");
  const [presetType, setPresetType] = useState<PresetCertType>(initialPreset);
  const [customType, setCustomType] = useState<string>(
    isNew
      ? ""
      : initialPreset === "custom" ? cert!.certification_type : "",
  );
  const [certNumber, setCertNumber] = useState<string>(cert?.cert_number || "");
  const [issuedAt, setIssuedAt] = useState<string>(cert?.issued_at || "");
  const [expiresAt, setExpiresAt] = useState<string>(cert?.expires_at || "");
  const [documentUrl, setDocumentUrl] = useState<string>(cert?.document_url || "");
  const [status, setStatus] = useState<CertStatus>(cert?.status || "active");

  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const certificationType = presetType === "custom" ? customType.trim() : presetType;
      if (!certificationType) {
        setErr("certification_type is required");
        setSubmitting(false);
        return;
      }
      const body: Record<string, unknown> = {
        vendor_id: vendorId,
        certification_type: certificationType,
        cert_number: certNumber.trim() || null,
        issued_at: issuedAt || null,
        expires_at: expiresAt || null,
        document_url: documentUrl.trim() || null,
        status,
      };
      let r: Response;
      if (isNew) {
        r = await fetch("/api/internal/procurement/compliance-certs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        r = await fetch(`/api/internal/procurement/compliance-certs/${cert!.id}`, {
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
    if (!cert) return;
    // T11 D3 — destructive op requires a reason.
    const reason = prompt("Delete reason (required for audit log):", "");
    if (!reason || !reason.trim()) return;
    setSubmitting(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/procurement/compliance-certs/${cert.id}`, {
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
        padding: 20, width: 720, maxWidth: "95vw", color: C.text,
      }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {isNew ? "Add certification" : "Edit certification"}
          {!isNew && (
            <span style={{ marginLeft: 12, fontSize: 12, color: statusColor(status) }}>● {status}</span>
          )}
        </h3>

        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Vendor">
            <SearchableSelect
              value={vendorId || null}
              onChange={(v) => setVendorId(v)}
              options={vendors.map((v) => ({ value: v.id, label: v.name }))}
              placeholder="(pick vendor…)"
              disabled={!isNew}
            />
          </Field>
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value as CertStatus)} style={{ ...inputStyle, color: statusColor(status), fontWeight: 600 }}>
              {(["active", "expired", "revoked", "pending"] as const).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Certification type">
            <SearchableSelect
              value={presetType}
              onChange={(v) => setPresetType((v || "OEKO-TEX") as PresetCertType)}
              options={PRESET_CERT_TYPES.map((t) => ({ value: t, label: t }))}
              placeholder="OEKO-TEX"
            />
          </Field>
          <Field label="Cert # (optional)">
            <input type="text" value={certNumber} onChange={(e) => setCertNumber(e.target.value)} style={inputStyle} placeholder="e.g. 12.HCN.85789" />
          </Field>
        </div>

        {presetType === "custom" && (
          <div style={{ marginBottom: 12 }}>
            <Field label="Custom certification type">
              <input type="text" value={customType} onChange={(e) => setCustomType(e.target.value)} style={inputStyle} placeholder="e.g. Fairtrade USA" />
            </Field>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Issued date">
            <input type="date" value={issuedAt} onChange={(e) => setIssuedAt(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Expires date">
            <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} style={inputStyle} />
          </Field>
        </div>

        <div style={{ marginBottom: 12 }}>
          <Field label="Document URL (M29 attachment)">
            <input
              type="url"
              value={documentUrl}
              onChange={(e) => setDocumentUrl(e.target.value)}
              style={{ ...inputStyle, fontFamily: "SFMono-Regular, Menlo, monospace" }}
              placeholder="https://… (paste link to uploaded cert PDF — full M29 widget pending)"
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
            <button onClick={() => void submit()} style={btnPrimary} disabled={submitting || !vendorId}>
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
