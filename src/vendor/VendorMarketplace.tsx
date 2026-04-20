import { useEffect, useState } from "react";
import { supabaseVendor } from "./supabaseVendor";

interface Listing {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  capabilities: string[];
  certifications: string[];
  geographic_coverage: string[];
  min_order_value: number | null;
  lead_time_range: string | null;
  status: "draft" | "published" | "suspended";
  views: number;
}
interface Inquiry {
  id: string;
  message: string;
  status: "sent" | "responded" | "converted_to_rfq";
  response: string | null;
  responded_at: string | null;
  created_at: string;
  entity?: { id: string; name: string } | null;
  inquired_by: string;
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

async function token() {
  const { data: { session } } = await supabaseVendor.auth.getSession();
  return session?.access_token || "";
}
async function api(path: string, init: RequestInit = {}) {
  const t = await token();
  return fetch(path, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${t}` } });
}

export default function VendorMarketplace() {
  const [listing, setListing] = useState<Listing | null>(null);
  const [inquiries, setInquiries] = useState<Inquiry[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const [rListing, rInquiries] = await Promise.all([
        api("/api/vendor/marketplace/listing"),
        api("/api/vendor/marketplace/inquiries"),
      ]);
      if (!rListing.ok) throw new Error(await rListing.text());
      const l = await rListing.json() as Listing | null;
      setListing(l);
      if (rInquiries.ok) {
        const d = await rInquiries.json() as { rows: Inquiry[] };
        setInquiries(d.rows || []);
      }
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function publishToggle() {
    if (!listing) return;
    const next = listing.status !== "published";
    const r = await api("/api/vendor/marketplace/listing/publish", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publish: next }),
    });
    if (!r.ok) { alert(await r.text()); return; }
    await load();
  }

  if (loading) return <div style={{ color: C.textMuted, padding: 20 }}>Loading…</div>;

  return (
    <div style={{ color: C.text, padding: 20 }}>
      <h2 style={{ margin: 0, fontSize: 22 }}>Marketplace</h2>
      <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4, marginBottom: 16 }}>Publish a listing to appear in buyer search results.</div>

      {err && <div style={{ color: C.danger, marginBottom: 10 }}>{err}</div>}

      <ListingEditor listing={listing} onSaved={load} onPublish={publishToggle} />

      <div style={{ marginTop: 24 }}>
        <h3 style={{ margin: "0 0 10px", fontSize: 17 }}>Inquiries ({inquiries.length})</h3>
        {inquiries.length === 0 ? (
          <div style={{ color: C.textMuted, fontSize: 12 }}>No inquiries yet.</div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {inquiries.map((q) => <InquiryCard key={q.id} inquiry={q} onResponded={load} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function ListingEditor({ listing, onSaved, onPublish }: { listing: Listing | null; onSaved: () => void; onPublish: () => void }) {
  const [title, setTitle] = useState(listing?.title || "");
  const [description, setDescription] = useState(listing?.description || "");
  const [category, setCategory] = useState(listing?.category || "");
  const [capabilities, setCapabilities] = useState((listing?.capabilities || []).join(", "));
  const [certs, setCerts] = useState((listing?.certifications || []).join(", "));
  const [geo, setGeo] = useState((listing?.geographic_coverage || []).join(", "));
  const [mov, setMov] = useState(listing?.min_order_value?.toString() || "");
  const [leadTime, setLeadTime] = useState(listing?.lead_time_range || "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setTitle(listing?.title || "");
    setDescription(listing?.description || "");
    setCategory(listing?.category || "");
    setCapabilities((listing?.capabilities || []).join(", "));
    setCerts((listing?.certifications || []).join(", "));
    setGeo((listing?.geographic_coverage || []).join(", "));
    setMov(listing?.min_order_value?.toString() || "");
    setLeadTime(listing?.lead_time_range || "");
  }, [listing?.id]);

  async function save() {
    if (!title.trim()) { alert("Title is required."); return; }
    setSaving(true);
    try {
      const r = await api("/api/vendor/marketplace/listing", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(), description: description.trim() || null, category: category.trim() || null,
          capabilities: capabilities.split(",").map((s) => s.trim()).filter(Boolean),
          certifications: certs.split(",").map((s) => s.trim()).filter(Boolean),
          geographic_coverage: geo.split(",").map((s) => s.trim()).filter(Boolean),
          min_order_value: mov ? Number(mov) : null,
          lead_time_range: leadTime.trim() || null,
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      onSaved();
    } catch (e: unknown) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  return (
    <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>Your listing</h3>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {listing && (
            <span style={{ fontSize: 11, color: listing.status === "published" ? C.success : C.textMuted, fontWeight: 700, textTransform: "uppercase" }}>
              {listing.status}{listing.status === "published" ? ` · 👁 ${listing.views}` : ""}
            </span>
          )}
          {listing && <button onClick={onPublish} style={{ ...btnSecondary, color: listing.status === "published" ? C.warn : C.success }}>{listing.status === "published" ? "Unpublish" : "Publish"}</button>}
        </div>
      </div>

      <Row label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} style={inp} /></Row>
      <Row label="Description"><textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} style={{ ...inp, resize: "vertical", fontFamily: "inherit" }} /></Row>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Row label="Category"><input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. metalwork" style={inp} /></Row>
        <Row label="Lead time range"><input value={leadTime} onChange={(e) => setLeadTime(e.target.value)} placeholder="2-4 weeks" style={inp} /></Row>
        <Row label="Capabilities (comma-separated)"><input value={capabilities} onChange={(e) => setCapabilities(e.target.value)} placeholder="CNC, laser cutting, welding" style={inp} /></Row>
        <Row label="Certifications (comma-separated)"><input value={certs} onChange={(e) => setCerts(e.target.value)} placeholder="ISO 9001, AS9100" style={inp} /></Row>
        <Row label="Geographic coverage"><input value={geo} onChange={(e) => setGeo(e.target.value)} placeholder="US, MX, CA" style={inp} /></Row>
        <Row label="Minimum order value (USD)"><input type="number" value={mov} onChange={(e) => setMov(e.target.value)} style={inp} /></Row>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
        <button onClick={() => void save()} disabled={saving} style={btnPrimary}>{saving ? "Saving…" : (listing ? "Save changes" : "Create listing")}</button>
      </div>
    </div>
  );
}

function InquiryCard({ inquiry, onResponded }: { inquiry: Inquiry; onResponded: () => void }) {
  const [responseText, setResponseText] = useState("");
  const [saving, setSaving] = useState(false);
  const canRespond = inquiry.status !== "converted_to_rfq";

  async function send() {
    if (!responseText.trim()) { alert("Write a response first."); return; }
    setSaving(true);
    try {
      const r = await api(`/api/vendor/marketplace/inquiries/${inquiry.id}/respond`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: responseText.trim() }),
      });
      if (!r.ok) throw new Error(await r.text());
      onResponded();
    } catch (e: unknown) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  return (
    <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontSize: 12, color: C.textSub }}>{inquiry.entity?.name || inquiry.entity_id} · {new Date(inquiry.created_at).toLocaleString()}</div>
        <span style={{ fontSize: 10, color: "#fff", background: inquiry.status === "converted_to_rfq" ? C.success : inquiry.status === "responded" ? C.primary : C.textSub, padding: "2px 8px", borderRadius: 10, fontWeight: 700, textTransform: "uppercase" }}>{inquiry.status.replace(/_/g, " ")}</span>
      </div>
      <div style={{ fontSize: 13, marginTop: 8, padding: 8, background: C.bg, border: `1px solid ${C.cardBdr}`, borderRadius: 6 }}>{inquiry.message}</div>
      {inquiry.response && (
        <div style={{ fontSize: 12, color: C.text, marginTop: 8, padding: 8, background: "rgba(59,130,246,0.08)", border: `1px solid ${C.primary}`, borderRadius: 6 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.primary, marginBottom: 4, textTransform: "uppercase" }}>Your response</div>
          {inquiry.response}
        </div>
      )}
      {canRespond && !inquiry.response && (
        <div style={{ marginTop: 10 }}>
          <textarea rows={3} value={responseText} onChange={(e) => setResponseText(e.target.value)} placeholder="Type your response…" style={{ ...inp, resize: "vertical", fontFamily: "inherit" }} />
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
            <button onClick={() => void send()} disabled={saving} style={btnPrimary}>{saving ? "Sending…" : "Send response"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const inp = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.bg, color: C.text, fontSize: 13, boxSizing: "border-box" } as const;
const btnPrimary = { padding: "8px 14px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "6px 12px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" } as const;
