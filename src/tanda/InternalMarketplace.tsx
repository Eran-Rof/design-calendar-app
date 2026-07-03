import { useEffect, useState } from "react";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import SearchableSelect from "./components/SearchableSelect";
import { notify } from "../shared/ui/warn";

interface Listing {
  id: string;
  vendor_id: string;
  title: string;
  description: string | null;
  category: string | null;
  capabilities: string[];
  certifications: string[];
  geographic_coverage: string[];
  min_order_value: number | null;
  lead_time_range: string | null;
  featured: boolean;
  status: string;
  views: number;
  esg_overall_score: number | null;
  vendor?: { id: string; name: string } | null;
}
interface Entity { id: string; name: string }

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

export default function InternalMarketplace() {
  const [rows, setRows] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [minEsg, setMinEsg] = useState("");
  const [inquireOn, setInquireOn] = useState<Listing | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (category) params.set("category", category);
      const r = await fetch(`/api/marketplace/listings?${params.toString()}`);
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json() as { rows: Listing[] };
      const min = Number(minEsg);
      const filtered = Number.isFinite(min) && minEsg !== ""
        ? (d.rows || []).filter((l) => l.esg_overall_score != null && Number(l.esg_overall_score) >= min)
        : (d.rows || []);
      setRows(filtered);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { const t = setTimeout(() => void load(), 250); return () => clearTimeout(t); }, [q, category, minEsg]);

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Marketplace</h2>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Discover vendors by capability, geography, and ESG score.</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input placeholder="Search capabilities, title, description…" value={q} onChange={(e) => setQ(e.target.value)} style={{ ...inp, width: 260 }} />
          <input placeholder="Category" value={category} onChange={(e) => setCategory(e.target.value)} style={{ ...inp, width: 160 }} />
          <input type="number" placeholder="Min ESG" value={minEsg} onChange={(e) => setMinEsg(e.target.value)} style={{ ...inp, width: 110 }} />
          <ExportButton
            rows={rows.map((l) => ({
              ...l,
              vendor_name: l.vendor?.name || "—",
              capabilities_list: (l.capabilities || []).join("; "),
              certifications_list: (l.certifications || []).join("; "),
              geographic_coverage_list: (l.geographic_coverage || []).join("; "),
            })) as unknown as Array<Record<string, unknown>>}
            filename="marketplace-listings"
            sheetName="Marketplace"
            columns={[
              { key: "title",                    header: "Title" },
              { key: "vendor_name",              header: "Vendor" },
              { key: "category",                 header: "Category" },
              { key: "description",              header: "Description" },
              { key: "capabilities_list",        header: "Capabilities" },
              { key: "certifications_list",      header: "Certifications" },
              { key: "geographic_coverage_list", header: "Geography" },
              { key: "min_order_value",          header: "MOV",     format: "number" },
              { key: "lead_time_range",          header: "Lead time" },
              { key: "esg_overall_score",        header: "ESG",     format: "number" },
              { key: "featured",                 header: "Featured" },
              { key: "status",                   header: "Status" },
              { key: "views",                    header: "Views",   format: "number" },
            ] as ExportColumn<Record<string, unknown>>[]}
          />
        </div>
      </div>

      {loading ? <div style={{ color: C.textMuted }}>Loading…</div>
      : err ? <div style={{ color: C.danger }}>Error: {err}</div>
      : rows.length === 0 ? (
        <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>No listings match.</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 12 }}>
          {rows.map((l) => (
            <div key={l.id} style={{ background: C.card, border: `1px solid ${l.featured ? C.warn : C.cardBdr}`, borderRadius: 8, padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{l.title}</div>
                {l.featured && <span style={{ fontSize: 10, color: "#fff", background: C.warn, padding: "2px 8px", borderRadius: 10, fontWeight: 700 }}>FEATURED</span>}
              </div>
              <div style={{ fontSize: 11, color: C.textSub, marginTop: 2 }}>{l.vendor?.name || "—"}{l.category ? ` · ${l.category}` : ""}</div>
              {l.description && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{l.description}</div>}

              {l.capabilities.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 8 }}>
                  {l.capabilities.slice(0, 6).map((c) => (
                    <span key={c} style={{ fontSize: 10, background: C.bg, border: `1px solid ${C.cardBdr}`, padding: "2px 6px", borderRadius: 8 }}>{c}</span>
                  ))}
                </div>
              )}

              <div style={{ display: "flex", gap: 10, fontSize: 10, color: C.textMuted, marginTop: 10 }}>
                <span>{l.views} views</span>
                {l.esg_overall_score !== null && <span style={{ color: C.success }}>ESG {Number(l.esg_overall_score).toFixed(0)}</span>}
                {l.lead_time_range && <span>{l.lead_time_range}</span>}
                {l.min_order_value != null && <span>MOV ${Number(l.min_order_value).toLocaleString()}</span>}
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                <button onClick={() => setInquireOn(l)} style={btnPrimary}>Inquire</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {inquireOn && <InquireModal listing={inquireOn} onClose={() => setInquireOn(null)} onSent={() => setInquireOn(null)} />}
    </div>
  );
}

function InquireModal({ listing, onClose, onSent }: { listing: Listing; onClose: () => void; onSent: () => void }) {
  const [message, setMessage] = useState("");
  const [entities, setEntities] = useState<Entity[]>([]);
  const [entityId, setEntityId] = useState("");
  const [inquirer, setInquirer] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await fetch("/api/internal/entities?flat=true");
      if (r.ok) {
        const e = (await r.json()) as Entity[];
        setEntities(e);
        if (e.length) setEntityId(e[0].id);
      }
    })();
  }, []);

  async function send() {
    if (!message.trim() || !entityId || !inquirer.trim()) { notify("All fields required.", "error"); return; }
    setSaving(true);
    try {
      const r = await fetch("/api/internal/marketplace/inquire", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listing_id: listing.id, entity_id: entityId, message: message.trim(), inquired_by: inquirer.trim() }),
      });
      if (!r.ok) throw new Error(await r.text());
      onSent();
    } catch (e: unknown) { notify(e instanceof Error ? e.message : String(e), "error"); }
    finally { setSaving(false); }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modal, width: "min(520px, 95vw)" }}>
        <h3 style={{ margin: "0 0 14px", fontSize: 18 }}>Inquire about "{listing.title}"</h3>
        <Row label="On behalf of entity">
          <SearchableSelect
            value={entityId || null}
            onChange={(v) => setEntityId(v)}
            options={entities.map((e) => ({ value: e.id, label: e.name }))}
            inputStyle={inp}
          />
        </Row>
        <Row label="Your name (for audit)"><input value={inquirer} onChange={(e) => setInquirer(e.target.value)} style={inp} /></Row>
        <Row label="Message"><textarea rows={5} value={message} onChange={(e) => setMessage(e.target.value)} style={{ ...inp, resize: "vertical", fontFamily: "inherit" }} /></Row>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={() => void send()} disabled={saving} style={btnPrimary}>{saving ? "Sending…" : "Send inquiry"}</button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const inp = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.bg, color: C.text, fontSize: 13, boxSizing: "border-box", colorScheme: "dark" } as const;
const btnPrimary = { padding: "8px 14px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "6px 12px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" } as const;
const overlay = { position: "fixed" as const, inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 };
const modal = { background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 22, maxHeight: "90vh", overflowY: "auto" as const, boxSizing: "border-box" as const, color: C.text };
