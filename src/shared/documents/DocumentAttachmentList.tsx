// src/shared/documents/DocumentAttachmentList.tsx
//
// Tangerine P2 Chunk 6 — reusable attachment widget.
// Drops into any panel via:
//   <DocumentAttachmentList contextTable="vendors" contextId={vendor.id} />
//
// Shows list + lets the user upload new docs (base64-via-JSON for MVP) and
// download via short-lived signed URLs. Archive button soft-deletes.
//
// Bytes-as-base64 is the MVP encoding — keeps the API surface single-content-
// type without a multipart parser. 25MB cap enforced in the handler.

import { useEffect, useRef, useState } from "react";
import { confirmDialog } from "../ui/warn";
import SearchableSelect from "../../tanda/components/SearchableSelect";

type DocVersion = {
  id: string;
  document_id: string;
  version_number: number;
  storage_path: string;
  mime_type: string;
  byte_size: number;
  sha256_hex: string;
  notes: string | null;
  original_filename: string | null;
  created_at: string;
};

type Doc = {
  id: string;
  entity_id: string;
  context_table: string;
  context_id: string;
  kind: string;
  title: string;
  current_version_id: string | null;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
  current_version: DocVersion | null;
};

const C = {
  card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", danger: "#EF4444",
};

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "6px 12px",
  borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600,
};
const btnSecondary: React.CSSProperties = {
  background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "4px 10px", borderRadius: 4, cursor: "pointer", fontSize: 11,
};
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
};

export type DocumentAttachmentListProps = {
  contextTable: string;
  contextId: string;
  /** Optional whitelist of kinds shown in the kind dropdown when uploading. */
  kinds?: string[];
  /** Compact mode hides the title bar. */
  compact?: boolean;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export default function DocumentAttachmentList({
  contextTable, contextId, kinds, compact,
}: DocumentAttachmentListProps) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      params.set("context_table", contextTable);
      params.set("context_id", contextId);
      const r = await fetch(`/api/internal/documents?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setDocs(await r.json());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [contextTable, contextId]);

  async function download(docId: string) {
    try {
      const r = await fetch(`/api/internal/documents/${docId}/signed-url`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const { url } = await r.json();
      window.open(url, "_blank");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function archive(docId: string) {
    if (!(await confirmDialog("Archive this document? (soft delete; recoverable)"))) return;
    const r = await fetch(`/api/internal/documents/${docId}/archive`, { method: "POST" });
    if (!r.ok) { setErr((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`); return; }
    void load();
  }

  async function doUpload(form: { file: File; kind: string; title: string; notes: string }) {
    setUploading(true);
    setErr(null);
    try {
      const bytes_base64 = await fileToBase64(form.file);
      const r = await fetch(`/api/internal/documents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          context_table: contextTable,
          context_id: contextId,
          kind: form.kind,
          title: form.title,
          // Keep the real filename for downloads (title is a free-text label).
          original_filename: form.file.name,
          mime: form.file.type || "application/octet-stream",
          bytes_base64,
          notes: form.notes || undefined,
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setUploadOpen(false);
      void load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div style={{
      background: C.card, border: `1px solid ${C.cardBdr}`,
      borderRadius: 8, padding: 14, color: C.text,
    }}>
      {!compact && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            Documents <span style={{ color: C.textMuted, fontSize: 11 }}>({docs.length})</span>
          </div>
          <button style={btnPrimary} onClick={() => setUploadOpen(true)}>+ Upload</button>
        </div>
      )}

      {err && <div style={{ background: "#7f1d1d", padding: 8, borderRadius: 4, marginBottom: 8, fontSize: 12 }}>{err}</div>}

      {loading && <div style={{ color: C.textMuted, fontSize: 12 }}>Loading…</div>}

      {!loading && docs.length === 0 && (
        <div style={{ color: C.textMuted, fontSize: 12, padding: "10px 0" }}>
          No documents attached.
        </div>
      )}

      {docs.map((d) => (
        <div key={d.id} style={{
          padding: "8px 0", borderTop: `1px solid ${C.cardBdr}`,
          display: "flex", alignItems: "center", gap: 10,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>
              {d.title} <span style={{ color: C.textMuted, fontSize: 11 }}>({d.kind})</span>
            </div>
            {d.current_version && (
              <div style={{ fontSize: 11, color: C.textSub, marginTop: 2 }}>
                v{d.current_version.version_number} · {d.current_version.mime_type} · {formatBytes(d.current_version.byte_size)} · {new Date(d.current_version.created_at).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })}
              </div>
            )}
          </div>
          <button style={btnSecondary} onClick={() => void download(d.id)}>Download</button>
          <button style={{ ...btnSecondary, color: C.danger, borderColor: "#7f1d1d" }} onClick={() => void archive(d.id)}>Archive</button>
        </div>
      ))}

      {uploadOpen && (
        <UploadModal
          kinds={kinds}
          onCancel={() => setUploadOpen(false)}
          onUpload={doUpload}
          uploading={uploading}
        />
      )}
    </div>
  );
}

function UploadModal({ kinds, onCancel, onUpload, uploading }: {
  kinds?: string[];
  onCancel: () => void;
  onUpload: (form: { file: File; kind: string; title: string; notes: string }) => Promise<void>;
  uploading: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState(kinds && kinds.length > 0 ? kinds[0] : "");
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    const file = fileRef.current?.files?.[0];
    if (!file) { setErr("Choose a file"); return; }
    if (!kind.trim()) { setErr("kind required"); return; }
    if (!title.trim()) { setErr("title required"); return; }
    await onUpload({ file, kind: kind.trim(), title: title.trim(), notes });
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
    }}>
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 24, width: "min(480px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box" }}>
        <h2 style={{ margin: "0 0 12px", fontSize: 16 }}>Upload document</h2>

        <div style={{ marginBottom: 10 }}>
          <label style={{ display: "block", color: C.textSub, fontSize: 11, marginBottom: 4 }}>File</label>
          <input ref={fileRef} type="file" style={{ color: C.textSub, fontSize: 13 }} />
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={{ display: "block", color: C.textSub, fontSize: 11, marginBottom: 4 }}>Kind</label>
          {kinds && kinds.length > 0 ? (
            <SearchableSelect
              value={kind || null}
              onChange={(v) => setKind(v)}
              inputStyle={inputStyle}
              options={kinds.map((k) => ({ value: k, label: k }))}
            />
          ) : (
            <input style={inputStyle} value={kind} onChange={(e) => setKind(e.target.value)} placeholder="contract, w9, packing_list, ..." />
          )}
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={{ display: "block", color: C.textSub, fontSize: 11, marginBottom: 4 }}>Title</label>
          <input style={inputStyle} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Human label for this document" />
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={{ display: "block", color: C.textSub, fontSize: 11, marginBottom: 4 }}>Notes (optional)</label>
          <textarea style={{ ...inputStyle, minHeight: 50 }} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        {err && <div style={{ background: "#7f1d1d", padding: 8, borderRadius: 4, fontSize: 12, marginBottom: 10 }}>{err}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button style={btnSecondary} onClick={onCancel} disabled={uploading}>Cancel</button>
          <button style={btnPrimary} onClick={() => void submit()} disabled={uploading}>
            {uploading ? "Uploading…" : "Upload"}
          </button>
        </div>
      </div>
    </div>
  );
}
