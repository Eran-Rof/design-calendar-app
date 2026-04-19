import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { TH } from "../utils/theme";
import { supabaseVendor } from "./supabaseVendor";
import { fmtDate } from "./utils";

interface DocType {
  id: string;
  code: string;
  name: string;
  description: string | null;
  requires_expiry: boolean;
  sort_order: number;
}

interface DocRow {
  id: string;
  type_id: string;
  file_path: string;
  file_name: string | null;
  file_size_bytes: number | null;
  file_mime_type: string | null;
  issued_at: string | null;
  expires_at: string | null;
  status: string;
  rejection_reason: string | null;
  reviewed_at: string | null;
  uploaded_at: string;
  notes: string | null;
}

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  pending_review: { bg: "#FEF3C7", fg: "#92400E" },
  approved:       { bg: "#D1FAE5", fg: "#065F46" },
  rejected:       { bg: "#FECACA", fg: "#991B1B" },
  expired:        { bg: "#E5E7EB", fg: "#6B7280" },
  superseded:     { bg: "#F3F4F6", fg: "#9CA3AF" },
};

function daysUntilExpiry(iso?: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso + "T00:00:00").getTime();
  if (Number.isNaN(t)) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((t - today.getTime()) / 86_400_000);
}

export default function ComplianceList() {
  const [types, setTypes] = useState<DocType[]>([]);
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [vendorUserId, setVendorUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const { data: userRes } = await supabaseVendor.auth.getUser();
      const uid = userRes.user?.id;
      if (!uid) throw new Error("Not signed in.");
      const { data: vu } = await supabaseVendor
        .from("vendor_users").select("id, vendor_id").eq("auth_id", uid).maybeSingle();
      if (!vu) throw new Error("Not linked to a vendor.");
      setVendorId(vu.vendor_id as string);
      setVendorUserId(vu.id as string);

      const [typeRes, docRes] = await Promise.all([
        supabaseVendor.from("compliance_document_types")
          .select("id, code, name, description, requires_expiry, sort_order")
          .eq("active", true).order("sort_order"),
        supabaseVendor.from("compliance_documents")
          .select("id, type_id, file_path, file_name, file_size_bytes, file_mime_type, issued_at, expires_at, status, rejection_reason, reviewed_at, uploaded_at, notes")
          .eq("vendor_id", vu.vendor_id).order("uploaded_at", { ascending: false }),
      ]);
      if (typeRes.error) throw typeRes.error;
      if (docRes.error) throw docRes.error;
      setTypes((typeRes.data ?? []) as DocType[]);
      setDocs((docRes.data ?? []) as DocRow[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const typeById = useMemo(() => {
    const m = new Map<string, DocType>();
    for (const t of types) m.set(t.id, t);
    return m;
  }, [types]);

  const stats = useMemo(() => {
    return {
      total: docs.length,
      approved: docs.filter((d) => d.status === "approved").length,
      pending: docs.filter((d) => d.status === "pending_review").length,
      rejected: docs.filter((d) => d.status === "rejected").length,
      expiring_soon: docs.filter((d) => {
        if (d.status !== "approved" || !d.expires_at) return false;
        const n = daysUntilExpiry(d.expires_at);
        return n != null && n <= 30 && n >= 0;
      }).length,
      expired: docs.filter((d) => d.status === "expired").length,
    };
  }, [docs]);

  async function downloadFile(path: string, filename: string | null) {
    const { data, error } = await supabaseVendor.storage.from("vendor-docs").createSignedUrl(path, 300);
    if (error) { alert("Download failed: " + error.message); return; }
    const a = document.createElement("a");
    a.href = data.signedUrl;
    a.download = filename ?? path.split("/").pop() ?? "document";
    a.target = "_blank";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  if (loading) return <div style={{ color: "#FFFFFF" }}>Loading compliance docs…</div>;
  if (err) return <div style={{ color: TH.primary, padding: "10px 12px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>;

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 20 }}>
        <StatCard label="Total" value={String(stats.total)} />
        <StatCard label="Approved" value={String(stats.approved)} tone="ok" />
        <StatCard label="Pending review" value={String(stats.pending)} tone={stats.pending > 0 ? "warn" : undefined} />
        <StatCard label="Expiring soon" value={String(stats.expiring_soon)} tone={stats.expiring_soon > 0 ? "warn" : undefined} />
        <StatCard label="Expired / rejected" value={String(stats.expired + stats.rejected)} tone={stats.expired + stats.rejected > 0 ? "err" : undefined} />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ fontSize: 14, color: "#FFFFFF" }}>
          Upload certificates and keep them current. Expiring docs are flagged 30 days ahead.
        </div>
        <button
          onClick={() => setShowUpload(true)}
          style={{ padding: "8px 14px", borderRadius: 6, border: "none", background: TH.primary, color: "#FFFFFF", cursor: "pointer", fontWeight: 600, fontSize: 13, fontFamily: "inherit" }}
        >
          + Upload document
        </button>
      </div>

      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, overflow: "hidden", boxShadow: `0 1px 2px ${TH.shadow}` }}>
        <div style={{ display: "grid", gridTemplateColumns: "260px 1fr 120px 120px 130px 130px", padding: "10px 14px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase" }}>
          <div>Document type</div>
          <div>File</div>
          <div>Issued</div>
          <div>Expires</div>
          <div>Status</div>
          <div style={{ textAlign: "right" }}>Uploaded</div>
        </div>
        {docs.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No documents uploaded yet.</div>
        ) : docs.map((d) => {
          const t = typeById.get(d.type_id);
          const c = STATUS_COLORS[d.status] ?? STATUS_COLORS.pending_review;
          const daysLeft = daysUntilExpiry(d.expires_at);
          const expiryWarn = d.status === "approved" && daysLeft != null && daysLeft >= 0 && daysLeft <= 30;
          return (
            <div key={d.id} style={{ display: "grid", gridTemplateColumns: "260px 1fr 120px 120px 130px 130px", padding: "12px 14px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 600, color: TH.text }}>{t?.name ?? "—"}</div>
                {d.rejection_reason && <div style={{ fontSize: 11, color: TH.primary, marginTop: 2 }}>⚠ {d.rejection_reason}</div>}
              </div>
              <div>
                <button
                  onClick={() => downloadFile(d.file_path, d.file_name)}
                  style={{ background: "none", border: "none", padding: 0, color: TH.primary, cursor: "pointer", fontFamily: "inherit", fontSize: 13, textAlign: "left" }}
                >
                  {d.file_name ?? d.file_path.split("/").pop()}
                </button>
              </div>
              <div style={{ color: TH.textSub2 }}>{fmtDate(d.issued_at)}</div>
              <div style={{ color: expiryWarn ? "#B45309" : TH.textSub2, fontWeight: expiryWarn ? 600 : 400 }}>
                {fmtDate(d.expires_at)}
                {expiryWarn && <div style={{ fontSize: 11 }}>in {daysLeft}d</div>}
              </div>
              <div>
                <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 10, background: c.bg, color: c.fg, fontWeight: 600, textTransform: "capitalize" }}>
                  {d.status.replace(/_/g, " ")}
                </span>
              </div>
              <div style={{ textAlign: "right", color: TH.textMuted, fontSize: 12 }}>{fmtDate(d.uploaded_at)}</div>
            </div>
          );
        })}
      </div>

      {showUpload && vendorId && vendorUserId && (
        <UploadModal
          types={types}
          vendorId={vendorId}
          vendorUserId={vendorUserId}
          onClose={() => setShowUpload(false)}
          onUploaded={() => { setShowUpload(false); void load(); }}
        />
      )}
    </div>
  );
}

function UploadModal({ types, vendorId, vendorUserId, onClose, onUploaded }: {
  types: DocType[]; vendorId: string; vendorUserId: string;
  onClose: () => void; onUploaded: () => void;
}) {
  const [typeId, setTypeId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [issuedAt, setIssuedAt] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const selectedType = types.find((t) => t.id === typeId);
  const requiresExpiry = selectedType?.requires_expiry ?? false;

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
  }

  async function submit() {
    setErr(null);
    if (!typeId) { setErr("Pick a document type."); return; }
    if (!file) { setErr("Choose a file."); return; }
    if (requiresExpiry && !expiresAt) { setErr("This document type requires an expiry date."); return; }

    setBusy(true);
    try {
      const docId = crypto.randomUUID();
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `${vendorId}/${docId}/${safeName}`;

      const up = await supabaseVendor.storage.from("vendor-docs").upload(path, file, {
        cacheControl: "3600",
        upsert: false,
        contentType: file.type,
      });
      if (up.error) throw up.error;

      const { error: insErr } = await supabaseVendor.from("compliance_documents").insert({
        id: docId,
        vendor_id: vendorId,
        type_id: typeId,
        file_path: path,
        file_name: file.name,
        file_size_bytes: file.size,
        file_mime_type: file.type,
        issued_at: issuedAt || null,
        expires_at: expiresAt || null,
        status: "pending_review",
        uploaded_by: vendorUserId,
        notes: notes.trim() || null,
      });
      if (insErr) {
        // Roll back the storage upload on DB failure
        await supabaseVendor.storage.from("vendor-docs").remove([path]);
        throw insErr;
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
        <div style={{ fontSize: 16, fontWeight: 700, color: TH.text, marginBottom: 4 }}>Upload compliance document</div>
        <div style={{ fontSize: 12, color: TH.textMuted, marginBottom: 18 }}>
          Submitted for internal review. You'll be notified when it's approved or if re-submission is needed.
        </div>

        <label style={labelStyle}>Document type</label>
        <select value={typeId} onChange={(e) => setTypeId(e.target.value)} style={inputStyle}>
          <option value="">— Select —</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>{t.name}{t.requires_expiry ? "" : " (no expiry)"}</option>
          ))}
        </select>
        {selectedType?.description && <div style={{ fontSize: 11, color: TH.textMuted, marginTop: 4 }}>{selectedType.description}</div>}

        <label style={labelStyle}>File</label>
        <input ref={fileRef} type="file" onChange={onFileChange} accept=".pdf,.jpg,.jpeg,.png,.doc,.docx" style={{ fontSize: 13, color: TH.textSub2, padding: "8px 0" }} />
        {file && (
          <div style={{ fontSize: 11, color: TH.textMuted, marginTop: 4 }}>
            {file.name} · {(file.size / 1024).toFixed(1)} KB
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 4 }}>
          <div>
            <label style={labelStyle}>Issued date</label>
            <input type="date" value={issuedAt} onChange={(e) => setIssuedAt(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Expires{requiresExpiry && <span style={{ color: TH.primary }}> *</span>}</label>
            <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} style={inputStyle} />
          </div>
        </div>

        <label style={labelStyle}>Notes (optional)</label>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical" }} />

        {err && (
          <div style={{ color: TH.primary, padding: "10px 12px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6, marginTop: 12, fontSize: 13 }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 18 }}>
          <button onClick={onClose} style={{ padding: "8px 14px", borderRadius: 7, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>Cancel</button>
          <button onClick={submit} disabled={busy || !typeId || !file} style={{ padding: "8px 16px", borderRadius: 7, border: "none", background: busy || !typeId || !file ? TH.textMuted : TH.primary, color: "#FFFFFF", cursor: busy ? "not-allowed" : "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600 }}>
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
