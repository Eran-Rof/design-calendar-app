import { useEffect, useState } from "react";
import InternalEntityBranding from "./InternalEntityBranding";

interface Entity {
  id: string;
  name: string;
  slug: string;
  status: string;
  parent_entity_id: string | null;
  branding: { company_display_name: string | null; logo_url: string | null; primary_color: string | null; custom_domain: string | null }[] | { company_display_name: string | null; logo_url: string | null; primary_color: string | null; custom_domain: string | null } | null;
  children?: Entity[];
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

export default function InternalEntities() {
  const [tree, setTree] = useState<Entity[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editBranding, setEditBranding] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/api/internal/entities");
      if (!r.ok) throw new Error(await r.text());
      setTree(await r.json() as Entity[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  if (editBranding) {
    return <InternalEntityBranding entityId={editBranding} onClose={() => setEditBranding(null)} onSaved={() => { setEditBranding(null); void load(); }} />;
  }

  if (loading) return <div style={{ color: C.textMuted }}>Loading…</div>;
  if (err) return <div style={{ color: C.danger }}>Error: {err}</div>;

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Entities</h2>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add entity</button>
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: "12px 16px" }}>
        {tree.length === 0 ? (
          <div style={{ color: C.textMuted, padding: 20, textAlign: "center" }}>No entities yet.</div>
        ) : tree.map((e) => <EntityNode key={e.id} entity={e} depth={0} onEditBranding={setEditBranding} onAdded={() => void load()} />)}
      </div>

      {addOpen && <AddEntityModal parent={null} onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); void load(); }} />}
    </div>
  );
}

function EntityNode({ entity, depth, onEditBranding, onAdded }: { entity: Entity; depth: number; onEditBranding: (id: string) => void; onAdded: () => void }) {
  const [addChild, setAddChild] = useState(false);
  const branding = Array.isArray(entity.branding) ? entity.branding[0] || null : (entity.branding || null);
  return (
    <div style={{ marginLeft: depth * 24, padding: "10px 0", borderLeft: depth > 0 ? `2px solid ${C.cardBdr}` : "none", paddingLeft: depth > 0 ? 14 : 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {branding?.primary_color && <div style={{ width: 10, height: 10, borderRadius: "50%", background: branding.primary_color }} />}
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{branding?.company_display_name || entity.name}</div>
          <div style={{ fontSize: 11, color: C.textMuted, fontFamily: "SFMono-Regular, Menlo, monospace" }}>
            {entity.slug}{branding?.custom_domain ? ` · ${branding.custom_domain}` : ""}
          </div>
        </div>
        <button onClick={() => onEditBranding(entity.id)} style={btnSecondary}>Branding</button>
        <button onClick={() => setAddChild(true)} style={btnSecondary}>+ Child</button>
      </div>
      {(entity.children || []).map((c) => <EntityNode key={c.id} entity={c} depth={depth + 1} onEditBranding={onEditBranding} onAdded={onAdded} />)}
      {addChild && <AddEntityModal parent={entity.id} onClose={() => setAddChild(false)} onSaved={() => { setAddChild(false); onAdded(); }} />}
    </div>
  );
}

function AddEntityModal({ parent, onClose, onSaved }: { parent: string | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) { alert("Name required"); return; }
    setSaving(true);
    try {
      const r = await fetch("/api/internal/entities", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), slug: slug.trim() || undefined, parent_entity_id: parent || undefined }),
      });
      if (!r.ok) throw new Error(await r.text());
      onSaved();
    } catch (e: unknown) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={modal}>
        <h3 style={{ margin: "0 0 14px", fontSize: 16, color: C.text }}>{parent ? "Add child entity" : "Add entity"}</h3>
        <Row label="Name"><input value={name} onChange={(e) => setName(e.target.value)} style={inp} /></Row>
        <Row label="Slug (auto-generated if blank)"><input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="west-division" style={inp} /></Row>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={() => void save()} disabled={saving} style={btnPrimary}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
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

const inp = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.bg, color: C.text, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" } as const;
const btnPrimary = { padding: "8px 16px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "6px 12px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" } as const;
const overlay = { position: "fixed" as const, inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 };
const modal = { background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 22, width: 500, maxWidth: "92vw", color: C.text };
