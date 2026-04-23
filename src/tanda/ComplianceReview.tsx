import { useEffect, useMemo, useState } from "react";
import { TH } from "../utils/theme";
import { SB_URL, SB_HEADERS, supabaseClient } from "../utils/supabase";
import { S } from "../utils/styles";
import { showFileViewer } from "../utils/fileViewer";

// Internal-only compliance document review tab. Reads all documents via
// the anon key (RLS anon-permissive), approves/rejects with notes.

interface DocType {
  id: string;
  code: string;
  name: string;
  required: boolean;
  expiry_required: boolean;
}

interface Doc {
  id: string;
  vendor_id: string;
  document_type_id: string;
  file_url: string;
  file_name: string | null;
  file_size_bytes: number | null;
  file_mime_type: string | null;
  issued_at: string | null;
  expiry_date: string | null;
  status: string;
  rejection_reason: string | null;
  reviewed_by: string | null;
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

function fmtDate(d?: string | null) {
  if (!d) return "—";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString();
}

export default function ComplianceReview() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [types, setTypes] = useState<DocType[]>([]);
  const [vendors, setVendors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("pending_review");
  const [vendorFilter, setVendorFilter] = useState("");
  const [search, setSearch] = useState("");
  const [reviewing, setReviewing] = useState<Doc | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const [docRes, typeRes, vRes] = await Promise.all([
        fetch(`${SB_URL}/rest/v1/compliance_documents?select=*&order=uploaded_at.desc`, { headers: SB_HEADERS }),
        fetch(`${SB_URL}/rest/v1/compliance_document_types?select=*&order=sort_order`, { headers: SB_HEADERS }),
        fetch(`${SB_URL}/rest/v1/vendors?select=id,name`, { headers: SB_HEADERS }),
      ]);
      if (!docRes.ok) throw new Error(`docs: ${docRes.status}`);
      if (!typeRes.ok) throw new Error(`types: ${typeRes.status}`);
      if (!vRes.ok) throw new Error(`vendors: ${vRes.status}`);
      setDocs(await docRes.json());
      setTypes(await typeRes.json());
      const vs: { id: string; name: string }[] = await vRes.json();
      const m: Record<string, string> = {};
      for (const v of vs) m[v.id] = v.name;
      setVendors(m);
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

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return docs.filter((d) => {
      if (statusFilter && d.status !== statusFilter) return false;
      if (vendorFilter && d.vendor_id !== vendorFilter) return false;
      if (!q) return true;
      const t = typeById.get(d.document_type_id);
      return (vendors[d.vendor_id] ?? "").toLowerCase().includes(q)
          || (t?.name ?? "").toLowerCase().includes(q)
          || (d.file_name ?? "").toLowerCase().includes(q);
    });
  }, [docs, typeById, vendors, statusFilter, vendorFilter, search]);

  const stats = useMemo(() => ({
    total: docs.length,
    pending: docs.filter((d) => d.status === "pending_review").length,
    approved: docs.filter((d) => d.status === "approved").length,
    rejected: docs.filter((d) => d.status === "rejected").length,
    expired: docs.filter((d) => d.status === "expired").length,
  }), [docs]);

  async function openFile(path: string, filename: string | null) {
    if (!supabaseClient) { alert("Supabase client unavailable"); return; }
    const { data, error } = await supabaseClient.storage.from("vendor-docs").createSignedUrl(path, 300);
    if (error) { alert("Open failed: " + error.message); return; }
    void showFileViewer({ signedUrl: data.signedUrl, filename: filename || path.split("/").pop() || "document" });
  }

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 16 }}>
        <StatCard label="Total" value={String(stats.total)} />
        <StatCard label="Pending review" value={String(stats.pending)} tone={stats.pending > 0 ? "warn" : undefined} />
        <StatCard label="Approved" value={String(stats.approved)} tone="ok" />
        <StatCard label="Rejected" value={String(stats.rejected)} tone={stats.rejected > 0 ? "err" : undefined} />
        <StatCard label="Expired" value={String(stats.expired)} />
      </div>

      <div style={{ ...S.card, marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input
            placeholder="Search vendor / doc type / filename…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ ...S.inp, marginBottom: 0, flex: "1 1 260px", minWidth: 240 }}
          />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ ...S.inp, marginBottom: 0, flex: "0 1 180px", minWidth: 140 }}>
            <option value="">All statuses</option>
            <option value="pending_review">Pending review</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="expired">Expired</option>
            <option value="superseded">Superseded</option>
          </select>
          <select value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)} style={{ ...S.inp, marginBottom: 0, flex: "0 1 220px", minWidth: 160 }}>
            <option value="">All vendors</option>
            {Object.entries(vendors).sort(([, a], [, b]) => a.localeCompare(b)).map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
          <div style={{ fontSize: 12, color: TH.textMuted, marginLeft: "auto" }}>{visible.length} of {docs.length}</div>
        </div>
      </div>

      {loading && <div style={{ color: TH.textMuted, padding: 20 }}>Loading…</div>}
      {err && <div style={{ color: "#B91C1C", background: "#FEF2F2", border: "1px solid #FCA5A5", padding: "10px 14px", borderRadius: 8 }}>Error: {err}</div>}

      {!loading && !err && (
        <div style={{ background: "#FFFFFF", border: `1px solid ${TH.border}`, borderRadius: 10, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 240px 200px 110px 110px 130px 130px", padding: "10px 14px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase" }}>
            <div>Vendor</div>
            <div>Document type</div>
            <div>File</div>
            <div>Issued</div>
            <div>Expires</div>
            <div>Status</div>
            <div style={{ textAlign: "right" }}>Uploaded</div>
          </div>
          {visible.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No documents match these filters.</div>
          ) : visible.map((d) => {
            const t = typeById.get(d.document_type_id);
            const c = STATUS_COLORS[d.status] ?? STATUS_COLORS.pending_review;
            return (
              <div key={d.id} onClick={() => setReviewing(d)} style={{ display: "grid", gridTemplateColumns: "1fr 240px 200px 110px 110px 130px 130px", padding: "12px 14px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center", cursor: "pointer" }}>
                <div style={{ fontWeight: 600, color: TH.text }}>{vendors[d.vendor_id] ?? "—"}</div>
                <div style={{ color: TH.textSub2 }}>
                  {t?.name ?? "—"}
                  {t?.required && <span style={{ fontSize: 10, color: TH.primary, marginLeft: 6 }}>• required</span>}
                </div>
                <div style={{ color: TH.primary, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {d.file_name ?? d.file_url.split("/").pop()}
                </div>
                <div style={{ color: TH.textSub2 }}>{fmtDate(d.issued_at)}</div>
                <div style={{ color: TH.textSub2 }}>{fmtDate(d.expiry_date)}</div>
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
      )}

      {reviewing && (
        <ReviewModal
          doc={reviewing}
          docType={typeById.get(reviewing.document_type_id)}
          vendorName={vendors[reviewing.vendor_id]}
          onClose={() => setReviewing(null)}
          onAction={() => { setReviewing(null); void load(); }}
          openFile={openFile}
        />
      )}
    </div>
  );
}

function ReviewModal({ doc, docType, vendorName, onClose, onAction, openFile }: {
  doc: Doc; docType?: DocType; vendorName?: string;
  onClose: () => void; onAction: () => void;
  openFile: (path: string, filename: string | null) => void;
}) {
  const [reviewerName, setReviewerName] = useState(() => localStorage.getItem("plm_user") ?? "Internal");
  const [rejectReason, setRejectReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function update(status: "approved" | "rejected") {
    setErr(null);
    if (status === "rejected" && !rejectReason.trim()) { setErr("Rejection reason is required."); return; }
    setBusy(true);
    try {
      const res = await fetch(`${SB_URL}/rest/v1/compliance_documents?id=eq.${doc.id}`, {
        method: "PATCH",
        headers: { ...SB_HEADERS, Prefer: "return=representation" },
        body: JSON.stringify({
          status,
          rejection_reason: status === "rejected" ? rejectReason.trim() : null,
          reviewed_by: reviewerName,
          reviewed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      onAction();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(17,24,39,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#FFFFFF", borderRadius: 12, padding: 24, width: "min(600px, 95vw)" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: TH.primary, marginBottom: 4 }}>REVIEW · {docType?.name ?? "—"}</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: TH.text, marginBottom: 18 }}>{vendorName ?? "—"}</div>

        <div style={{ background: TH.surfaceHi, border: `1px solid ${TH.border}`, borderRadius: 8, padding: 14, marginBottom: 14 }}>
          <InfoRow label="File">
            <button onClick={() => openFile(doc.file_url, doc.file_name)} style={{ background: "none", border: "none", padding: 0, color: TH.primary, cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>
              {doc.file_name ?? doc.file_url.split("/").pop()} ↗
            </button>
          </InfoRow>
          <InfoRow label="Issued">{fmtDate(doc.issued_at)}</InfoRow>
          <InfoRow label="Expires">{fmtDate(doc.expiry_date)}</InfoRow>
          <InfoRow label="Uploaded">{fmtDate(doc.uploaded_at)}</InfoRow>
          <InfoRow label="Current status">
            <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: STATUS_COLORS[doc.status]?.bg, color: STATUS_COLORS[doc.status]?.fg, fontWeight: 600, textTransform: "capitalize" }}>
              {doc.status.replace(/_/g, " ")}
            </span>
          </InfoRow>
          {doc.notes && <InfoRow label="Vendor notes">{doc.notes}</InfoRow>}
          {doc.rejection_reason && <InfoRow label="Previous rejection">{doc.rejection_reason}</InfoRow>}
        </div>

        <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: TH.textSub, marginBottom: 6 }}>Your name (for the audit trail)</label>
        <input value={reviewerName} onChange={(e) => setReviewerName(e.target.value)} style={{ ...S.inp, marginBottom: 14 }} />

        <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: TH.textSub, marginBottom: 6 }}>Rejection reason (required if rejecting)</label>
        <textarea rows={2} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} style={{ ...S.inp, fontFamily: "inherit", resize: "vertical" }} />

        {err && <div style={{ marginTop: 12, color: "#B91C1C", background: "#FEF2F2", border: "1px solid #FCA5A5", padding: "8px 12px", borderRadius: 6, fontSize: 13 }}>{err}</div>}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 18 }}>
          <button onClick={onClose} style={{ padding: "8px 14px", borderRadius: 7, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>Cancel</button>
          <button onClick={() => update("rejected")} disabled={busy} style={{ padding: "8px 16px", borderRadius: 7, border: "1px solid #B91C1C", background: "#FEF2F2", color: "#B91C1C", cursor: busy ? "not-allowed" : "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600 }}>
            Reject
          </button>
          <button onClick={() => update("approved")} disabled={busy} style={{ padding: "8px 16px", borderRadius: 7, border: "none", background: "#047857", color: "#FFFFFF", cursor: busy ? "not-allowed" : "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600 }}>
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", fontSize: 13, marginBottom: 6 }}>
      <div style={{ color: TH.textMuted, fontWeight: 600 }}>{label}</div>
      <div style={{ color: TH.text }}>{children}</div>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" | "err" }) {
  const color = tone === "ok" ? "#047857" : tone === "warn" ? "#B45309" : tone === "err" ? "#B91C1C" : TH.text;
  return (
    <div style={{ background: "#FFFFFF", border: `1px solid ${TH.border}`, borderRadius: 8, padding: "14px 16px" }}>
      <div style={{ fontSize: 11, color: TH.textMuted, textTransform: "uppercase", fontWeight: 600, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}
