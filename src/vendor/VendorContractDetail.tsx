import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { TH } from "../utils/theme";
import { supabaseVendor } from "./supabaseVendor";
import StatusBadge, { contractTone } from "./StatusBadge";
import { fmtDate, fmtMoney } from "./utils";

interface Contract {
  id: string;
  vendor_id: string;
  title: string;
  description: string | null;
  contract_type: string;
  status: string;
  start_date: string | null;
  end_date: string | null;
  value: number | null;
  currency: string;
  file_url: string | null;
  signed_file_url: string | null;
  signed_at: string | null;
  internal_owner: string | null;
}

interface Version {
  id: string;
  version_number: number;
  file_url: string;
  notes: string | null;
  uploaded_by_type: "vendor" | "internal";
  created_at: string;
}

async function signedUrl(path: string): Promise<string | null> {
  const { data } = await supabaseVendor.storage.from("vendor-contracts").createSignedUrl(path, 600);
  return data?.signedUrl || null;
}

export default function VendorContractDetail() {
  const { id } = useParams<{ id: string }>();
  const [contract, setContract] = useState<Contract | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [signOpen, setSignOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [signing, setSigning] = useState(false);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const { data: { session } } = await supabaseVendor.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error("Not authenticated");
      const r = await fetch(`/api/vendor/contracts/${id}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      setContract(data.contract);
      setVersions(data.versions);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [id]);

  async function download(path: string) {
    const url = await signedUrl(path);
    if (url) window.open(url, "_blank");
    else alert("Could not generate download link.");
  }

  async function submitSign() {
    if (!file || !contract) return;
    if (file.type !== "application/pdf") { alert("Please upload a PDF."); return; }
    if (file.size > 20 * 1024 * 1024) { alert("File exceeds 20MB limit."); return; }
    setSigning(true);
    try {
      const path = `${contract.vendor_id}/${contract.id}/signed_${Date.now()}_${file.name}`;
      const { error: upErr } = await supabaseVendor.storage.from("vendor-contracts").upload(path, file, { upsert: false, contentType: "application/pdf" });
      if (upErr) throw upErr;
      const { data: { session } } = await supabaseVendor.auth.getSession();
      const token = session?.access_token;
      const r = await fetch(`/api/vendor/contracts/${contract.id}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ file_url: path, file_name: file.name, file_size_bytes: file.size, file_mime_type: file.type }),
      });
      if (!r.ok) throw new Error(await r.text());
      setSignOpen(false);
      setFile(null);
      await load();
    } catch (e: unknown) {
      alert(`Sign failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSigning(false);
    }
  }

  if (loading) return <div style={{ color: TH.textMuted }}>Loading…</div>;
  if (err) return <div style={{ color: TH.primary, padding: 12, background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>;
  if (!contract) return null;

  return (
    <div>
      <Link to="/vendor/contracts" style={{ color: "rgba(255,255,255,0.8)", fontSize: 13, textDecoration: "none" }}>← Contracts</Link>

      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, padding: "20px 22px", marginTop: 12, boxShadow: `0 1px 2px ${TH.shadow}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
          <div>
            <div style={{ fontSize: 11, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.05, fontWeight: 700 }}>{contract.contract_type.replace(/_/g, " ")}</div>
            <h2 style={{ margin: "4px 0 8px", color: TH.text, fontSize: 22 }}>{contract.title}</h2>
            {contract.description && <div style={{ color: TH.textSub2, fontSize: 13, marginBottom: 8 }}>{contract.description}</div>}
            <StatusBadge label={contract.status === "under_review" ? "Under review" : contract.status[0].toUpperCase() + contract.status.slice(1)} tone={contractTone(contract.status)} />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {contract.file_url && (
              <button onClick={() => void download(contract.file_url!)} style={btnSecondary}>Download latest</button>
            )}
            {contract.status === "sent" && (
              <button onClick={() => setSignOpen(true)} style={btnPrimary}>Sign</button>
            )}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginTop: 18 }}>
          <Field label="Start date" value={fmtDate(contract.start_date)} />
          <Field label="End date"   value={fmtDate(contract.end_date)} />
          <Field label="Value"      value={contract.value != null ? fmtMoney(contract.value) : "—"} />
          <Field label="Signed"     value={contract.signed_at ? fmtDate(contract.signed_at) : "—"} />
        </div>
      </div>

      <h3 style={{ color: "#FFFFFF", marginTop: 24, marginBottom: 10 }}>Version history</h3>
      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, overflow: "hidden" }}>
        {versions.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No versions yet.</div>
        ) : versions.map((v) => (
          <div key={v.id} style={{ display: "grid", gridTemplateColumns: "80px 140px 1fr 120px", padding: "10px 14px", borderBottom: `1px solid ${TH.border}`, alignItems: "center", fontSize: 13 }}>
            <div style={{ fontWeight: 700, color: TH.text }}>v{v.version_number}</div>
            <div style={{ color: TH.textSub2 }}>{v.uploaded_by_type === "vendor" ? "Vendor" : "Internal"}</div>
            <div style={{ color: TH.textSub2 }}>{v.notes || ""}</div>
            <div style={{ textAlign: "right" }}>
              <button onClick={() => void download(v.file_url)} style={{ ...btnSecondary, padding: "4px 10px", fontSize: 12 }}>Download</button>
            </div>
          </div>
        ))}
      </div>

      {signOpen && (
        <Modal title={`Sign contract: ${contract.title}`} onClose={() => { setSignOpen(false); setFile(null); }}>
          <p style={{ color: TH.textSub2, fontSize: 13, margin: "0 0 14px" }}>Upload a countersigned PDF (max 20MB). Once submitted, the contract status will change to <b>signed</b>.</p>
          <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} style={{ marginBottom: 14 }} />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button onClick={() => { setSignOpen(false); setFile(null); }} style={btnSecondary}>Cancel</button>
            <button onClick={() => void submitSign()} disabled={!file || signing} style={{ ...btnPrimary, opacity: !file || signing ? 0.6 : 1 }}>
              {signing ? "Signing…" : "Submit signed PDF"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.05, fontWeight: 700 }}>{label}</div>
      <div style={{ color: TH.text, fontSize: 14, fontWeight: 500, marginTop: 3 }}>{value}</div>
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: TH.surface, borderRadius: 10, padding: 22, width: 480, maxWidth: "92vw", boxShadow: "0 10px 40px rgba(0,0,0,0.3)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <h3 style={{ margin: 0, color: TH.text, fontSize: 16 }}>{title}</h3>
          <button onClick={onClose} style={{ border: "none", background: "transparent", fontSize: 20, color: TH.textMuted, cursor: "pointer" }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

const btnPrimary = { padding: "8px 16px", borderRadius: 6, border: "none", background: TH.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "8px 16px", borderRadius: 6, border: `1px solid ${TH.border}`, background: TH.surfaceHi, color: TH.text, cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
