// src/tanda/components/CustomerLocations.tsx
//
// Ship-to locations sub-panel embedded inside the Customer Master edit modal.
// Lists the customer's distribution centres / stores; supports Add, Edit,
// and soft-Delete (sets active=false) per location.
//
// Each location's address is edited using the shared <AddressFields> component
// (backed by a jsonb column — same pattern as customers.billing_address).
//
// API:
//   GET  /api/internal/customer-locations?customer_id=...  → CustomerLocation[]
//   POST /api/internal/customer-locations                   → CustomerLocation
//   PATCH /api/internal/customer-locations/:id             → CustomerLocation
//   DELETE /api/internal/customer-locations/:id            → 204 (soft-delete)

import { useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { newWorkbook, addAoaSheet, downloadExcelWorkbook } from "../../shared/excelLogo";
import { notify, confirmDialog } from "../../shared/ui/warn";
import AddressFields, { type Address } from "./AddressFields";
import { formatUsPhone } from "../../shared/phone";
import SearchableSelect from "./SearchableSelect";

type LocationType = "dc" | "store" | "other";

type CustomerLocation = {
  id: string;
  customer_id: string;
  code: string | null;
  name: string;
  location_type: LocationType;
  address: Address;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  is_default: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
};

type LocationDraft = {
  name: string;
  code: string;
  location_type: LocationType;
  address: Address;
  contact_name: string;
  phone: string;
  email: string;
  is_default: boolean;
};

const LOCATION_TYPE_LABELS: Record<LocationType, string> = {
  dc: "DC", store: "Store", other: "Other",
};

// Headers for the bulk-store-upload template + parser (must match exactly).
const STORE_UPLOAD_HEADERS = [
  "code", "name", "location_type",
  "address_line1", "city", "state", "postal", "country",
  "contact_name", "phone", "email",
];

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
  boxSizing: "border-box",
};
const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "5px 10px", borderRadius: 5, cursor: "pointer", fontSize: 12,
};
const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0,
  padding: "6px 12px", borderRadius: 5, cursor: "pointer", fontSize: 12, fontWeight: 600,
};
const btnDanger: React.CSSProperties = { ...btnSecondary, color: C.danger, borderColor: "#7f1d1d" };

function emptyDraft(location_type: LocationType = "store"): LocationDraft {
  return { name: "", code: "", location_type, address: {}, contact_name: "", phone: "", email: "", is_default: false };
}

function addrSummary(addr: Address): string {
  if (!addr) return "—";
  const parts = [addr.line1, addr.city, addr.state, addr.postal ?? addr.postal_code, addr.country].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "—";
}

interface LocationFormProps {
  draft: LocationDraft;
  onChange: (d: LocationDraft) => void;
}

function LocationForm({ draft, onChange }: LocationFormProps) {
  const set = <K extends keyof LocationDraft>(k: K, v: LocationDraft[K]) => onChange({ ...draft, [k]: v });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Name *</div>
          <input
            style={inputStyle}
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="e.g. Los Angeles DC"
          />
        </div>
        <div>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Code</div>
          <input
            style={inputStyle}
            value={draft.code}
            onChange={(e) => set("code", e.target.value)}
            placeholder="Short code (optional)"
          />
        </div>
        <div>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Type</div>
          <SearchableSelect
            inputStyle={inputStyle as React.CSSProperties}
            value={draft.location_type}
            onChange={(v) => set("location_type", v as LocationType)}
            options={[
              { value: "dc", label: "DC (distribution center)" },
              { value: "store", label: "Store" },
              { value: "other", label: "Other" },
            ]}
          />
        </div>
        <div>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Contact name</div>
          <input
            style={inputStyle}
            value={draft.contact_name}
            onChange={(e) => set("contact_name", e.target.value)}
            placeholder="Receiving contact"
          />
        </div>
        <div>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Phone</div>
          <input
            style={inputStyle}
            value={draft.phone}
            onChange={(e) => set("phone", formatUsPhone(e.target.value))}
            placeholder="(555) 000-0000"
          />
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Email</div>
          <input
            style={inputStyle}
            type="email"
            value={draft.email}
            onChange={(e) => set("email", e.target.value)}
            placeholder="receiving@example.com"
          />
        </div>
      </div>
      <AddressFields
        label="Shipping address"
        value={draft.address}
        onChange={(a) => set("address", a)}
      />
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: C.textSub }}>
        <input
          type="checkbox"
          checked={draft.is_default}
          onChange={(e) => set("is_default", e.target.checked)}
        />
        Default ship-to for this customer
      </label>
    </div>
  );
}

interface LocationModalProps {
  customerId: string;
  existing?: CustomerLocation;
  defaultType?: LocationType;
  onClose: () => void;
  onSaved: () => void;
}

function LocationModal({ customerId, existing, defaultType = "store", onClose, onSaved }: LocationModalProps) {
  const isEdit = !!existing;
  const [draft, setDraft] = useState<LocationDraft>(
    existing
      ? {
          name:          existing.name,
          code:          existing.code ?? "",
          location_type: existing.location_type ?? "store",
          address:       existing.address ?? {},
          contact_name:  existing.contact_name ?? "",
          phone:         existing.phone ?? "",
          email:         existing.email ?? "",
          is_default:    existing.is_default,
        }
      : emptyDraft(defaultType),
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!draft.name.trim()) {
      setErr("Name is required.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        name:          draft.name.trim(),
        code:          draft.code.trim() || null,
        location_type: draft.location_type,
        address:       draft.address,
        contact_name:  draft.contact_name.trim() || null,
        phone:         draft.phone.trim() || null,
        email:         draft.email.trim() || null,
        is_default:    draft.is_default,
      };
      let url: string;
      let method: string;
      if (isEdit) {
        url = `/api/internal/customer-locations/${existing.id}`;
        method = "PATCH";
      } else {
        url = "/api/internal/customer-locations";
        method = "POST";
        body.customer_id = customerId;
      }
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 200,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10,
          padding: 20, width: "min(520px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box",
          color: C.text,
        }}
      >
        <h4 style={{ margin: "0 0 14px", fontSize: 16 }}>
          {isEdit ? `Edit location — ${existing.name}` : `Add ${LOCATION_TYPE_LABELS[defaultType]} location`}
        </h4>
        <LocationForm draft={draft} onChange={setDraft} />
        {err && (
          <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 12 }}>
            {err}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary} disabled={saving}>Cancel</button>
          <button onClick={() => void save()} style={btnPrimary} disabled={saving}>
            {saving ? "Saving…" : isEdit ? "Save changes" : "Add location"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface CustomerLocationsProps {
  customerId: string;
}

export default function CustomerLocations({ customerId }: CustomerLocationsProps) {
  const [locations, setLocations] = useState<CustomerLocation[]>([]);
  const [loading, setLoading] = useState(true);
  // `addType` is non-null while the Add modal is open; it seeds location_type.
  const [addType, setAddType] = useState<LocationType | null>(null);
  const [editing, setEditing] = useState<CustomerLocation | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = await fetch(`/api/internal/customer-locations?customer_id=${encodeURIComponent(customerId)}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setLocations(await r.json() as CustomerLocation[]);
    } catch (e: unknown) {
      notify(`Failed to load locations: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [customerId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function softDelete(loc: CustomerLocation) {
    if (!(await confirmDialog(`Remove location "${loc.name}"? It will be hidden but not hard-deleted (AR invoices may still reference it).`))) return;
    try {
      const r = await fetch(`/api/internal/customer-locations/${loc.id}`, { method: "DELETE" });
      if (!r.ok && r.status !== 204) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      await load();
    } catch (e: unknown) {
      notify(`Remove failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  // Build + download an .xlsx template with exactly the upload headers plus
  // one example data row, using the same xlsx lib the exports use.
  function downloadTemplate() {
    const exampleRow = [
      "STORE-001", "Downtown Store", "store",
      "123 Main St", "Los Angeles", "CA", "90001", "US",
      "Jane Buyer", "+1 (555) 000-0000", "store@example.com",
    ];
    const aoa = [STORE_UPLOAD_HEADERS, exampleRow];
    const wb = newWorkbook();
    addAoaSheet(wb, "Stores", aoa, { title: "Customer Locations — Upload Template", subtitle: "Fill one row per store, then upload. The example row below shows the format." });
    void downloadExcelWorkbook(wb, "store-upload-template.xlsx");
  }

  // Parse an .xlsx client-side and POST one customer_locations row per data
  // row. location_type defaults to 'store' when blank/invalid.
  function handleUploadFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input so re-selecting the same file fires onChange again.
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const wb = XLSX.read(ev.target?.result, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][];
        if (aoa.length < 2) {
          notify("No data rows found in the spreadsheet.", "error");
          return;
        }
        const headerRow = (aoa[0] || []).map((h) => String(h).trim().toLowerCase());
        const col = (name: string) => headerRow.indexOf(name);
        const idxName = col("name");
        if (idxName < 0) {
          notify(`Missing required "name" column. Expected headers: ${STORE_UPLOAD_HEADERS.join(", ")}`, "error");
          return;
        }
        const cell = (row: unknown[], name: string): string => {
          const i = col(name);
          return i >= 0 ? String(row[i] ?? "").trim() : "";
        };

        const drafts = aoa.slice(1)
          .filter((row) => String(row[idxName] ?? "").trim() !== "")
          .map((row) => {
            const ltRaw = cell(row, "location_type").toLowerCase();
            const location_type: LocationType =
              ltRaw === "dc" || ltRaw === "other" ? ltRaw : "store";
            const address: Address = {
              line1: cell(row, "address_line1") || undefined,
              city: cell(row, "city") || undefined,
              state: cell(row, "state") || undefined,
              postal: cell(row, "postal") || undefined,
              country: cell(row, "country") || undefined,
            };
            return {
              customer_id: customerId,
              name: cell(row, "name"),
              code: cell(row, "code") || null,
              location_type,
              address,
              contact_name: cell(row, "contact_name") || null,
              phone: cell(row, "phone") || null,
              email: cell(row, "email") || null,
            };
          });

        if (drafts.length === 0) {
          notify("No rows with a non-empty name to import.", "error");
          return;
        }
        if (!(await confirmDialog(`Import ${drafts.length} location(s) for this customer?`))) return;

        setUploading(true);
        let ok = 0;
        const errors: string[] = [];
        for (const body of drafts) {
          try {
            const r = await fetch("/api/internal/customer-locations", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
            if (!r.ok) {
              const j = await r.json().catch(() => ({}));
              throw new Error(j.error || `HTTP ${r.status}`);
            }
            ok += 1;
          } catch (err: unknown) {
            errors.push(`${body.name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        await load();
        if (errors.length === 0) {
          notify(`Imported ${ok} location(s).`, "success");
        } else {
          notify(`Imported ${ok}, ${errors.length} failed:\n${errors.slice(0, 5).join("\n")}`, "error");
        }
      } catch (err: unknown) {
        notify(`Upload failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      } finally {
        setUploading(false);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>
          Ship-to locations
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button onClick={() => setAddType("dc")} style={btnSecondary} disabled={uploading}>+ Add DC</button>
          <button onClick={() => setAddType("store")} style={btnSecondary} disabled={uploading}>+ Add Store</button>
          <button onClick={() => fileRef.current?.click()} style={btnSecondary} disabled={uploading}>
            {uploading ? "Uploading…" : "Upload stores (Excel)"}
          </button>
          <button onClick={downloadTemplate} style={btnSecondary} disabled={uploading}>Download template</button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={handleUploadFile}
            style={{ display: "none" }}
          />
        </div>
      </div>

      {loading ? (
        <div style={{ fontSize: 12, color: C.textMuted, padding: "8px 0" }}>Loading…</div>
      ) : locations.length === 0 ? (
        <div style={{ fontSize: 12, color: C.textMuted, padding: "8px 0" }}>
          No ship-to locations. Add one to enable ship-to selection on AR invoices.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {locations.map((loc) => (
            <div
              key={loc.id}
              style={{
                background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 6,
                padding: "8px 12px", display: "flex", alignItems: "flex-start", justifyContent: "space-between",
                gap: 12,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 600, fontSize: 13, color: C.text }}>{loc.name}</span>
                  {loc.code && (
                    <span style={{ fontSize: 11, color: C.textMuted, fontFamily: "SFMono-Regular, Menlo, monospace" }}>
                      {loc.code}
                    </span>
                  )}
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 8,
                    background: "#334155", color: "#cbd5e1", textTransform: "uppercase", letterSpacing: 0.5,
                  }}>
                    {LOCATION_TYPE_LABELS[loc.location_type] ?? loc.location_type}
                  </span>
                  {loc.is_default && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 8,
                      background: "#1e3a5f", color: "#93c5fd", textTransform: "uppercase", letterSpacing: 0.5,
                    }}>
                      Default
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                  {addrSummary(loc.address)}
                </div>
                {(loc.contact_name || loc.phone || loc.email) && (
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                    {[loc.contact_name, loc.phone, loc.email].filter(Boolean).join(" · ")}
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <button onClick={() => setEditing(loc)} style={btnSecondary}>Edit</button>
                <button onClick={() => void softDelete(loc)} style={btnDanger}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {addType && (
        <LocationModal
          customerId={customerId}
          defaultType={addType}
          onClose={() => setAddType(null)}
          onSaved={() => { setAddType(null); void load(); }}
        />
      )}
      {editing && (
        <LocationModal
          customerId={customerId}
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}
