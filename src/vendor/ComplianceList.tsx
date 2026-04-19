import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { TH } from "../utils/theme";
import { supabaseVendor } from "./supabaseVendor";
import { fmtDate } from "./utils";

// Grouped compliance checklist. Data via /api/vendor/compliance which
// returns { complete, expiring_soon, missing, rejected } with document
// type + optional latest document per row.

interface DocType {
  id: string;
  code: string;
  name: string;
  description: string | null;
  required: boolean;
  expiry_required: boolean;
  sort_order: number;
}

interface Doc {
  id: string;
  document_type_id: string;
  file_url: string;
  file_name: string | null;
  file_size_bytes: number | null;
  file_mime_type: string | null;
  issued_at: string | null;
  expiry_date: string | null;
  status: string;
  rejection_reason: string | null;
  reviewed_at: string | null;
  uploaded_at: string;
  notes: string | null;
}

interface GroupEntry {
  document_type: DocType;
  document: Doc | null;
}

interface Grouped {
  complete: GroupEntry[];
  expiring_soon: GroupEntry[];
  missing: GroupEntry[];
  rejected: GroupEntry[];
}

function badgeFor(entry: GroupEntry, sectionKey: keyof Grouped): { label: string; bg: string; fg: string } {
  if (sectionKey === "missing" && !entry.document) return { label: "Missing", bg: "#E5E7EB", fg: "#6B7280" };
  const s = entry.document?.status;
  if (s === "pending_review") return { label: "Pending review", bg: "#DBEAFE", fg: "#1E40AF" };
  if (s === "approved")       return { label: "Approved",       bg: "#D1FAE5", fg: "#065F46" };
  if (s === "rejected")       return { label: "Rejected",       bg: "#FECACA", fg: "#991B1B" };
  if (s === "expired")        return { label: "Expired",        bg: "#E5E7EB", fg: "#6B7280" };
  if (sectionKey === "expiring_soon") return { label: "Expiring soon", bg: "#FEF3C7", fg: "#92400E" };
  return { label: s || "—", bg: "#F3F4F6", fg: "#9CA3AF" };
}

async function authedFetch(path: string, init?: RequestInit) {
  const { data } = await supabaseVendor.auth.getSession();
  const token = data?.session?.access_token;
  return fetch(path, {
    ...init,
    headers: { ...(init?.headers || {}), Authorization: `Bearer ${token}` },
  });
}

export default function ComplianceList() {
  const [groups, setGroups] = useState<Grouped>({ complete: [], expiring_soon: [], missing: [], rejected: [] });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [uploadingFor, setUploadingFor] = useState<GroupEntry | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await authedFetch("/api/vendor/compliance");
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || `Request failed (${r.status})`);
      setGroups(body as Grouped);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function downloadFile(path: string) {
    const { data, error } = await supabaseVendor.storage.from("vendor-docs").createSignedUrl(path, 300);
    if (error) { alert("Download failed: " + error.message); return; }
    window.open(data.signedUrl, "_blank", "noopener");
  }

  const counts = {
    complete: groups.complete.length,
    expiring_soon: groups.expiring_soon.length,
    missing: groups.missing.length,
    rejected: groups.rejected.length,
  };
  const totalTracked = counts.complete + counts.expiring_soon + counts.missing + counts.rejected;

  if (loading) return <div style={{ color: "#FFFFFF" }}>Loading compliance…</div>;
  if (err) return <div style={{ color: TH.primary, padding: "10px 12px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>;

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
        <StatCard label="Complete"       value={`${counts.complete} / ${totalTracked}`} tone="ok" />
        <StatCard label="Action needed"  value={String(counts.rejected + counts.missing)} tone={counts.rejected + counts.missing > 0 ? "err" : undefined} />
        <StatCard label="Expiring soon"  value={String(counts.expiring_soon)} tone={counts.expiring_soon > 0 ? "warn" : undefined} />
        <StatCard label="Rejected"       value={String(counts.rejected)} tone={counts.rejected > 0 ? "err" : undefined} />
      </div>

      <div style={{ color: "#FFFFFF", fontSize: 14, marginBottom: 16 }}>
        Upload certificates and keep them current. Expiring docs are flagged 30-60 days ahead depending on type.
      </div>

      <Section title="Action needed" tone="err" rows={[...groups.missing, ...groups.rejected]} sectionKey="missing" onDownload={downloadFile} onUpload={setUploadingFor} emptyText="Nothing needs your attention." />
      <Section title="Expiring soon" tone="warn" rows={groups.expiring_soon} sectionKey="expiring_soon" onDownload={downloadFile} onUpload={setUploadingFor} emptyText="No documents expiring in the next 60 days." />
      <Section title="Complete" tone="ok" rows={groups.complete} sectionKey="complete" onDownload={downloadFile} onUpload={setUploadingFor} emptyText="No approved documents on file." />

      {uploadingFor && <UploadModal entry={uploadingFor} onClose={() => setUploadingFor(null)} onUploaded={() => { setUploadingFor(null); void load(); }} />}
    </div>
  );
}

function Section({ title, tone, rows, sectionKey, onDownload, onUpload, emptyText }: {
  title: string; tone: "ok" | "warn" | "err";
  rows: GroupEntry[]; sectionKey: keyof Grouped;
  onDownload: (path: string) => void;
  onUpload: (entry: GroupEntry) => void;
  emptyText: string;
}) {
  const accent = tone === "ok" ? "#047857" : tone === "warn" ? "#B45309" : TH.primary;
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <span style={{ width: 10, height: 10, borderRadius: 999, background: accent }} />
        <div style={{ color: "#FFFFFF", fontWeight: 700, fontSize: 14, letterSpacing: 0.3 }}>{title}</div>
        <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 12 }}>{rows.length}</span>
      </div>
      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, overflow: "hidden", boxShadow: `0 1px 2px ${TH.shadow}` }}>
        {rows.length === 0 ? (
          <div style={{ padding: 16, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>{emptyText}</div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "280px 140px 120px 120px 1fr 110px", padding: "10px 14px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase" }}>
              <div>Document type</div>
              <div>Status</div>
              <div>Expires</div>
              <div>Uploaded</div>
              <div>File / notes</div>
              <div style={{ textAlign: "right" }}>Action</div>
            </div>
            {rows.map((e) => {
              const b = badgeFor(e, sectionKey);
              const d = e.document;
              return (
                <div key={`${e.document_type.id}-${d?.id ?? "missing"}`} style={{ display: "grid", gridTemplateColumns: "280px 140px 120px 120px 1fr 110px", padding: "12px 14px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center" }}>
                  <div>
                    <div style={{ fontWeight: 600, color: TH.text }}>{e.document_type.name}</div>
                    {e.document_type.required && <div style={{ fontSize: 10, color: TH.primary, marginTop: 2 }}>REQUIRED</div>}
                  </div>
                  <div>
                    <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 10, background: b.bg, color: b.fg, fontWeight: 600 }}>{b.label}</span>
                  </div>
                  <div style={{ color: TH.textSub2 }}>{fmtDate(d?.expiry_date)}</div>
                  <div style={{ color: TH.textSub2 }}>{fmtDate(d?.uploaded_at)}</div>
                  <div>
                    {d?.file_url ? (
                      <button onClick={() => onDownload(d.file_url)} style={{ background: "none", border: "none", padding: 0, color: TH.primary, cursor: "pointer", fontFamily: "inherit", fontSize: 12, textAlign: "left" }}>
                        {d.file_name ?? d.file_url.split("/").pop()}
                      </button>
                    ) : (
                      <span style={{ color: TH.textMuted, fontSize: 12 }}>Not uploaded</span>
                    )}
                    {d?.rejection_reason && (
                      <div style={{ fontSize: 11, color: TH.primary, marginTop: 2 }}>⚠ {d.rejection_reason}</div>
                    )}
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <button onClick={() => onUpload(e)} style={{ padding: "5px 12px", borderRadius: 6, border: d ? `1px solid ${TH.border}` : "none", background: d ? TH.surface : TH.primary, color: d ? TH.textSub : "#FFFFFF", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}>
                      {d ? "Re-upload" : "Upload"}
                    </button>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

function UploadModal({ entry, onClose, onUploaded }: { entry: GroupEntry; onClose: () => void; onUploaded: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [issuedAt, setIssuedAt] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
  }

  async function submit() {
    setErr(null);
    if (!file) { setErr("Choose a file."); return; }
    if (entry.document_type.expiry_required && !expiryDate) {
      setErr("This document type requires an expiry date.");
      return;
    }
    if (file.size > 20 * 1024 * 1024) { setErr("File exceeds 20MB limit."); return; }
    if (!/^(application\/pdf|image\/)/i.test(file.type)) { setErr("Only PDF or image files are allowed."); return; }

    setBusy(true);
    try {
      const { data: userRes } = await supabaseVendor.auth.getUser();
      const uid = userRes.user?.id;
      if (!uid) throw new Error("Not signed in.");
      const { data: vu } = await supabaseVendor.from("vendor_users").select("vendor_id").eq("auth_id", uid).maybeSingle();
      if (!vu) throw new Error("Not linked to a vendor.");

      const docId = crypto.randomUUID();
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `${vu.vendor_id}/${docId}/${safeName}`;

      const up = await supabaseVendor.storage.from("vendor-docs").upload(path, file, {
        cacheControl: "3600", upsert: false, contentType: file.type,
      });
      if (up.error) throw up.error;

      // Call the API so the server-side notification fires.
      const r = await authedFetch("/api/vendor/compliance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          document_type_id: entry.document_type.id,
          expiry_date: expiryDate || null,
          issued_at: issuedAt || null,
          notes: notes.trim() || null,
          file_url: path,
          file_name: file.name,
          file_size_bytes: file.size,
          file_mime_type: file.type,
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        await supabaseVendor.storage.from("vendor-docs").remove([path]);
        throw new Error(body?.error || `Upload failed (${r.status})`);
      }
      onUploaded();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(17,24,39,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: TH.surface, borderRadius: 12, padding: 24, width: "min(500px, 95vw)" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: TH.primary, marginBottom: 4 }}>UPLOAD</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: TH.text, marginBottom: 4 }}>{entry.document_type.name}</div>
        {entry.document_type.description && <div style={{ fontSize: 12, color: TH.textMuted, marginBottom: 18 }}>{entry.document_type.description}</div>}

        <label style={labelStyle}>File (PDF or image, max 20MB)</label>
        <input ref={fileRef} type="file" onChange={onFileChange} accept=".pdf,.jpg,.jpeg,.png,.doc,.docx" style={{ fontSize: 13, color: TH.textSub2, padding: "8px 0" }} />
        {file && <div style={{ fontSize: 11, color: TH.textMuted, marginTop: 4 }}>{file.name} · {(file.size / 1024).toFixed(1)} KB</div>}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 4 }}>
          <div>
            <label style={labelStyle}>Issued date</label>
            <input type="date" value={issuedAt} onChange={(e) => setIssuedAt(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Expires{entry.document_type.expiry_required && <span style={{ color: TH.primary }}> *</span>}</label>
            <input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} style={inputStyle} />
          </div>
        </div>

        <label style={labelStyle}>Notes (optional)</label>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical" }} />

        {err && <div style={{ color: TH.primary, padding: "10px 12px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6, marginTop: 12, fontSize: 13 }}>{err}</div>}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 18 }}>
          <button onClick={onClose} style={{ padding: "8px 14px", borderRadius: 7, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>Cancel</button>
          <button onClick={submit} disabled={busy || !file} style={{ padding: "8px 16px", borderRadius: 7, border: "none", background: busy || !file ? TH.textMuted : TH.primary, color: "#FFFFFF", cursor: busy ? "not-allowed" : "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600 }}>
            {busy ? "Uploading…" : "Upload"}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" | "err" }) {
  const color = tone === "ok" ? "#047857" : tone === "warn" ? "#B45309" : tone === "err" ? TH.primary : TH.text;
  return (
    <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, padding: "14px 16px", boxShadow: `0 1px 2px ${TH.shadow}` }}>
      <div style={{ fontSize: 11, color: TH.textMuted, textTransform: "uppercase", fontWeight: 600, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

const labelStyle = { display: "block", fontSize: 12, fontWeight: 600, color: TH.textSub, marginTop: 10, marginBottom: 4 };
const inputStyle = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${TH.border}`, fontSize: 13, boxSizing: "border-box" as const, fontFamily: "inherit" };
