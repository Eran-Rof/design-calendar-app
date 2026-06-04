import { useEffect, useMemo, useState } from "react";
import { notify } from "../shared/ui/warn";
import InternalEntityBranding from "./InternalEntityBranding";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";

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
  const [coaCopyEntity, setCoaCopyEntity] = useState<Entity | null>(null);

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

  // Flatten the entity tree into a row-per-entity list for export (depth indicates hierarchy).
  // Called before any conditional returns to obey Rules of Hooks.
  const flatRows = useMemo(() => {
    const out: Array<Record<string, unknown>> = [];
    function walk(nodes: Entity[], depth: number, parentName: string | null) {
      for (const e of nodes) {
        const branding = Array.isArray(e.branding) ? e.branding[0] || null : (e.branding || null);
        out.push({
          depth,
          name: e.name,
          display_name: branding?.company_display_name || e.name,
          slug: e.slug,
          status: e.status,
          parent_name: parentName,
          parent_entity_id: e.parent_entity_id,
          custom_domain: branding?.custom_domain ?? null,
          primary_color: branding?.primary_color ?? null,
          logo_url: branding?.logo_url ?? null,
        });
        if (e.children && e.children.length > 0) walk(e.children, depth + 1, e.name);
      }
    }
    walk(tree, 0, null);
    return out;
  }, [tree]);

  if (editBranding) {
    return <InternalEntityBranding entityId={editBranding} onClose={() => setEditBranding(null)} onSaved={() => { setEditBranding(null); void load(); }} />;
  }

  if (loading) return <div style={{ color: C.textMuted }}>Loading…</div>;
  if (err) return <div style={{ color: C.danger }}>Error: {err}</div>;

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Entities</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <ExportButton
            rows={flatRows}
            filename="entities"
            sheetName="Entities"
            columns={[
              { key: "depth",            header: "Depth", format: "number" },
              { key: "name",             header: "Name" },
              { key: "display_name",     header: "Display Name" },
              { key: "slug",             header: "Slug" },
              { key: "status",           header: "Status" },
              { key: "parent_name",      header: "Parent" },
              { key: "parent_entity_id", header: "Parent Entity ID" },
              { key: "custom_domain",    header: "Custom Domain" },
              { key: "primary_color",    header: "Primary Color" },
              { key: "logo_url",         header: "Logo URL" },
            ] as ExportColumn<Record<string, unknown>>[]}
          />
          <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add entity</button>
        </div>
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: "12px 16px" }}>
        {tree.length === 0 ? (
          <div style={{ color: C.textMuted, padding: 20, textAlign: "center" }}>No entities yet.</div>
        ) : tree.map((e) => <EntityNode key={e.id} entity={e} depth={0} onEditBranding={setEditBranding} onCoaCopy={setCoaCopyEntity} onAdded={() => void load()} />)}
      </div>

      {addOpen && <AddEntityModal parent={null} onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); void load(); }} />}
      {coaCopyEntity && <CoaCopyModal entity={coaCopyEntity} onClose={() => setCoaCopyEntity(null)} />}
    </div>
  );

  // Hoist setter into tree render. Done above via the EntityNode prop chain.
}

function EntityNode({ entity, depth, onEditBranding, onCoaCopy, onAdded }: { entity: Entity; depth: number; onEditBranding: (id: string) => void; onCoaCopy: (e: Entity) => void; onAdded: () => void }) {
  const [addChild, setAddChild] = useState(false);
  const branding = Array.isArray(entity.branding) ? entity.branding[0] || null : (entity.branding || null);
  // P10-6: ROF itself doesn't need a "Copy COA from ROF" button — it IS ROF.
  // Match by slug since `code` is not exposed in the tree response shape.
  const isRof = entity.slug === "rof" || entity.slug === "ringoffire";
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
        {!isRof && <button onClick={() => onCoaCopy(entity)} style={btnSecondary} title="Seed this entity's Chart of Accounts from ROF">Copy COA from ROF</button>}
        <button onClick={() => onEditBranding(entity.id)} style={btnSecondary}>Branding</button>
        <button onClick={() => setAddChild(true)} style={btnSecondary}>+ Child</button>
      </div>
      {(entity.children || []).map((c) => <EntityNode key={c.id} entity={c} depth={depth + 1} onEditBranding={onEditBranding} onCoaCopy={onCoaCopy} onAdded={onAdded} />)}
      {addChild && <AddEntityModal parent={entity.id} onClose={() => setAddChild(false)} onSaved={() => { setAddChild(false); onAdded(); }} />}
    </div>
  );
}

// P10-6: COA copy-from-ROF wizard. Confirmation modal → POST → result line.
// The handler is idempotent so re-running is safe; we still confirm before the
// first POST because the operator may have already started editing the COA in
// the target entity manually.
export function CoaCopyModal({ entity, onClose }: { entity: { id: string; name: string }; onClose: () => void }) {
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ inserted: number; skipped: number; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch(`/api/internal/entities/${entity.id}/coa-copy-from-rof`, { method: "POST" });
      const body = await r.json();
      if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
      setResult(body);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={modal}>
        <h3 style={{ margin: "0 0 14px", fontSize: 16, color: C.text }}>Copy Chart of Accounts from ROF</h3>
        {!result && !error && (
          <>
            <div style={{ color: C.textSub, fontSize: 13, lineHeight: 1.5, marginBottom: 16 }}>
              This will copy every <strong>active</strong> account from the ROF chart of accounts into
              <strong> {entity.name}</strong>. Existing codes will be skipped. Parent-account links are
              cleared on the copies — you can re-parent rows afterwards in the COA admin.
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
              <button onClick={() => void run()} style={btnPrimary} disabled={submitting}>
                {submitting ? "Copying…" : "Copy COA"}
              </button>
            </div>
          </>
        )}
        {result && (
          <>
            <div style={{ color: C.success, fontSize: 13, marginBottom: 12 }}>{result.message}</div>
            <div style={{ color: C.textSub, fontSize: 13, marginBottom: 16 }}>
              <div>Inserted: <strong>{result.inserted}</strong></div>
              <div>Skipped: <strong>{result.skipped}</strong></div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button onClick={onClose} style={btnPrimary}>Close</button>
            </div>
          </>
        )}
        {error && (
          <>
            <div style={{ color: C.danger, fontSize: 13, marginBottom: 16 }}>Error: {error}</div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button onClick={onClose} style={btnSecondary}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function AddEntityModal({ parent, onClose, onSaved }: { parent: string | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [slug, setSlug] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) { notify("Name required", "error"); return; }
    if (!code.trim()) { notify("Code required (short uppercase, e.g. SAG)", "error"); return; }
    setSaving(true);
    try {
      const r = await fetch("/api/internal/entities", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), code: code.trim(), slug: slug.trim() || undefined, parent_entity_id: parent || undefined }),
      });
      if (!r.ok) throw new Error(await r.text());
      const created = await r.json().catch(() => null);
      if (created?.coa_warning) notify(created.coa_warning, "error");
      else notify(`Entity created${created?.coa_cloned ? ` — ${created.coa_cloned} accounts cloned from ROF` : ""}.`, "success");
      onSaved();
    } catch (e: unknown) { notify(e instanceof Error ? e.message : String(e), "error"); }
    finally { setSaving(false); }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={modal}>
        <h3 style={{ margin: "0 0 14px", fontSize: 16, color: C.text }}>{parent ? "Add child entity" : "Add entity"}</h3>
        <Row label="Name"><input value={name} onChange={(e) => setName(e.target.value)} style={inp} placeholder="Syndicated Apparel Group" /></Row>
        <Row label="Code (short, uppercase)"><input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} style={inp} placeholder="SAG" /></Row>
        <Row label="Slug (auto-generated if blank)"><input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="west-division" style={inp} /></Row>
        <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 10 }}>A starter Chart of Accounts is cloned from ROF on create.</div>
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
