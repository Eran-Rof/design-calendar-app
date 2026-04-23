// AttachmentsManager — polymorphic multi-file uploader/viewer.
//
// Drop this into any vendor screen that needs file attachments on a
// record. Handles multiple uploads (either via a multi-select <input>
// or by adding files across several passes), previews inline via
// showFileViewer, description edit, soft-delete.
//
// Usage:
//   <AttachmentsManager
//     entityType="invoice"
//     entityId={invoiceId}
//     storageFolder={`${vendorId}/invoices`}   // Supabase Storage path prefix
//     readOnly={false}
//   />

import { useEffect, useState } from "react";
import { supabaseVendor } from "../supabaseVendor";
import { showAlert, showConfirm } from "./AppDialog";
import { showFileViewer } from "../../utils/fileViewer";
import { TH } from "../theme";

export type AttachmentEntityType =
  | "invoice"
  | "shipment"
  | "po"
  | "po_message"
  | "dispute"
  | "contract"
  | "compliance_document"
  | "rfq_quote"
  | "bulk_operation";

interface AttachmentRow {
  id: string;
  file_url: string;
  file_description: string | null;
  filename: string | null;
  uploaded_at: string;
  uploaded_by_auth_id: string | null;
}

const DESCRIPTION_PRESETS = [
  "Invoice PDF",
  "Packing list",
  "Bill of lading",
  "Commercial invoice",
  "Certificate of origin",
  "Inspection certificate",
  "Credit memo",
  "Supporting Excel",
  "Photo",
  "Other",
];

const MAX_BYTES = 20 * 1024 * 1024;  // 20 MB each
const ACCEPT = "application/pdf,.pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xls,.xlsx,image/*,.csv,.docx,.doc,.pptx,.ppt,text/plain,.txt";

async function token() {
  const { data: { session } } = await supabaseVendor.auth.getSession();
  return session?.access_token || "";
}

export default function AttachmentsManager({
  entityType,
  entityId,
  storageFolder,
  readOnly = false,
  onChange,
  label = "Attachments",
}: {
  entityType: AttachmentEntityType;
  entityId: string | null;
  storageFolder: string; // e.g. `${vendorId}/invoices`
  readOnly?: boolean;
  onChange?: (rows: AttachmentRow[]) => void;
  label?: string;
}) {
  const [rows, setRows] = useState<AttachmentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(0); // count of in-flight uploads
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    if (!entityId) { setRows([]); return; }
    setLoading(true); setErr(null);
    try {
      const t = await token();
      const r = await fetch(`/api/vendor/attachments?entity_type=${entityType}&entity_id=${entityId}`, {
        headers: { Authorization: `Bearer ${t}` },
      });
      if (!r.ok) throw new Error(await r.text());
      const body = (await r.json()) as { rows: AttachmentRow[] };
      setRows(body.rows || []);
      onChange?.(body.rows || []);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [entityId, entityType]);

  async function uploadOne(file: File, description: string) {
    if (file.size > MAX_BYTES) throw new Error(`"${file.name}" exceeds 20 MB.`);
    const safeName = file.name.replace(/\s+/g, "_");
    const path = `${storageFolder}/${Date.now()}_${safeName}`;
    const { error: upErr } = await supabaseVendor.storage.from("vendor-docs").upload(path, file, { upsert: false });
    if (upErr) throw upErr;
    const t = await token();
    const r = await fetch(`/api/vendor/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
      body: JSON.stringify({
        entity_type: entityType,
        entity_id: entityId,
        file_url: path,
        file_description: description || null,
        filename: file.name,
      }),
    });
    if (!r.ok) throw new Error(await r.text());
  }

  async function handlePick(files: FileList | null) {
    if (!files || files.length === 0 || !entityId) return;
    setErr(null);
    setUploading(files.length);
    try {
      const arr = Array.from(files);
      // Ask once for a shared description suggestion; blank = per-file auto-default.
      const defaultDesc = arr.length === 1 ? "Invoice PDF" : "";
      const description = defaultDesc;
      for (const f of arr) {
        await uploadOne(f, description || guessDescription(f.name));
        setUploading((n) => n - 1);
      }
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(0);
    }
  }

  async function handleDelete(row: AttachmentRow) {
    const ok = await showConfirm({
      title: "Remove attachment?",
      message: `"${row.filename || row.file_url.split("/").pop()}" will be removed from this record. The file stays in storage for audit purposes.`,
      confirmLabel: "Remove", tone: "danger",
    });
    if (!ok) return;
    try {
      const t = await token();
      const r = await fetch(`/api/vendor/attachments/${row.id}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${t}` },
      });
      if (!r.ok) throw new Error(await r.text());
      await load();
    } catch (e: unknown) {
      await showAlert({ title: "Delete failed", message: e instanceof Error ? e.message : String(e), tone: "danger" });
    }
  }

  async function handleRename(row: AttachmentRow, next: string) {
    if (next === (row.file_description || "")) return;
    try {
      const t = await token();
      const r = await fetch(`/api/vendor/attachments/${row.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({ file_description: next }),
      });
      if (!r.ok) throw new Error(await r.text());
      await load();
    } catch (e: unknown) {
      await showAlert({ title: "Rename failed", message: e instanceof Error ? e.message : String(e), tone: "danger" });
    }
  }

  async function handlePreview(row: AttachmentRow) {
    const { data, error } = await supabaseVendor.storage.from("vendor-docs").createSignedUrl(row.file_url, 300);
    if (error) { await showAlert({ title: "Couldn't open", message: error.message, tone: "danger" }); return; }
    await showFileViewer({ signedUrl: data.signedUrl, filename: row.filename || row.file_url.split("/").pop() || "document" });
  }

  return (
    <div style={{ background: TH.surfaceHi, border: `1px solid ${TH.border}`, borderRadius: 8, padding: "10px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.4 }}>
          {label} {rows.length > 0 && <span style={{ color: TH.textSub }}>({rows.length})</span>}
        </div>
        {!readOnly && entityId && (
          <label style={{
            padding: "4px 12px", borderRadius: 6, cursor: "pointer",
            background: TH.primary, color: "#fff", fontSize: 12, fontWeight: 600,
            border: "none", fontFamily: "inherit", display: "inline-block",
          }}>
            + Add file{uploading > 0 ? ` (${uploading}…)` : "s"}
            <input
              type="file"
              multiple
              accept={ACCEPT}
              style={{ display: "none" }}
              onChange={(e) => { void handlePick(e.target.files); e.target.value = ""; }}
            />
          </label>
        )}
      </div>
      {err && <div style={{ color: "#FCA5A5", fontSize: 12, marginBottom: 8 }}>{err}</div>}
      {loading && rows.length === 0 ? (
        <div style={{ color: TH.textMuted, fontSize: 12 }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: TH.textMuted, fontSize: 12, padding: "4px 0" }}>
          {entityId ? "No attachments yet." : "Save this record first to attach files."}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          {rows.map((row) => (
            <AttachmentRowView
              key={row.id}
              row={row}
              readOnly={readOnly}
              onRename={(next) => void handleRename(row, next)}
              onDelete={() => void handleDelete(row)}
              onPreview={() => void handlePreview(row)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function guessDescription(filename: string): string {
  const n = filename.toLowerCase();
  if (n.includes("packing")) return "Packing list";
  if (n.includes("bill") && n.includes("lading")) return "Bill of lading";
  if (n.includes("cert")) return "Certificate";
  if (n.endsWith(".pdf")) return "Invoice PDF";
  if (n.endsWith(".xlsx") || n.endsWith(".xls") || n.endsWith(".csv")) return "Supporting Excel";
  return "";
}

function AttachmentRowView({
  row, readOnly, onRename, onDelete, onPreview,
}: {
  row: { id: string; file_url: string; file_description: string | null; filename: string | null; uploaded_at: string };
  readOnly: boolean;
  onRename: (next: string) => void;
  onDelete: () => void;
  onPreview: () => void;
}) {
  const [draft, setDraft] = useState(row.file_description || "");
  useEffect(() => { setDraft(row.file_description || ""); }, [row.file_description]);

  const fname = row.filename || row.file_url.split("/").pop() || "document";
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: readOnly ? "1fr auto" : "minmax(160px, 220px) 1fr auto",
      alignItems: "center", gap: 8,
      padding: "6px 10px", background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 6,
    }}>
      {!readOnly && (
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => onRename(draft.trim())}
          placeholder="Description…"
          list="attachment-description-options"
          style={{
            padding: "4px 8px", borderRadius: 4,
            border: `1px solid ${TH.border}`, background: TH.bg, color: TH.text,
            fontSize: 12, fontFamily: "inherit",
          }}
        />
      )}
      <div style={{ minWidth: 0 }}>
        {readOnly && row.file_description && (
          <div style={{ fontSize: 12, fontWeight: 600, color: TH.text }}>{row.file_description}</div>
        )}
        <div style={{
          fontSize: 11, color: TH.textMuted, fontFamily: "Menlo, monospace",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{fname}</div>
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        <button onClick={onPreview} style={iconBtn}>Preview</button>
        {!readOnly && <button onClick={onDelete} style={{ ...iconBtn, color: "#FCA5A5" }}>Remove</button>}
      </div>
      <datalist id="attachment-description-options">
        {DESCRIPTION_PRESETS.map((p) => <option key={p} value={p} />)}
      </datalist>
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  padding: "3px 10px", borderRadius: 4,
  border: `1px solid ${TH.border}`, background: "transparent", color: TH.textSub,
  cursor: "pointer", fontFamily: "inherit", fontSize: 11, fontWeight: 600,
};
