// Costing Module — Settings / Masters view.
//
// Lets the operator manage the small attribute lists used by grid cell
// dropdowns: Fit, Closure, Waist, Comment templates. Also exposes the
// operator-only freeform Color + Vendor masters — those mirror what the
// operator typed in the grid and are auto-pruned by the server when the
// name appears in the canonical sources (ip_item_master.color for colors,
// ip_vendor_master / vendors for vendors).

import React, { useEffect, useState } from "react";
import { useCostingStore, type MasterKind, type MasterEntry } from "../store/costingStore";
import { appConfirm } from "../../utils/theme";

const SECTIONS: { kind: MasterKind; title: string; description: string; placeholder: string }[] = [
  { kind: "fit",     title: "Fit",     description: "Fit options for the grid (Standard, Relaxed, Slim, …).", placeholder: "e.g. Relaxed" },
  { kind: "closure", title: "Closures", description: "Closure options (Jogger, Open Bottom, Drawstring, …).", placeholder: "e.g. Jogger" },
  { kind: "waist",   title: "Waist Type", description: "Waist construction (E-Waist, Fixed, Drawstring, …).", placeholder: "e.g. E-Waist" },
  { kind: "comment",    title: "Comment Templates", description: "Reusable comment snippets the operator can insert into a line.", placeholder: 'e.g. "Please make E/W"' },
  // Fabric is no longer a costing-owned master — the grid's Fabric cell now
  // sources exclusively from Tangerine fabric_codes (multi-select + free-add).
  // The Fabric master card was removed so operators aren't editing a list that
  // no longer feeds the grid.
  { kind: "compliance", title: "Compliance Codes", description: "Requirement codes the grid Compliance dropdown offers (CPSIA, PROP65, FLAMMABILITY, etc.). Auto-seeded the first time the master loads empty.", placeholder: "e.g. CALIFORNIA_PROP65" },
];

export default function SettingsView() {
  const masters      = useCostingStore((s) => s.masters);
  const extraColors  = useCostingStore((s) => s.extraColors);
  const extraVendors = useCostingStore((s) => s.extraVendors);
  const load         = useCostingStore((s) => s.loadMasters);

  useEffect(() => { load(); }, [load]);

  return (
    <div style={{ padding: "20px 24px", background: "#0F172A", minHeight: "100%", color: "#E2E8F0" }}>
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Costing Masters</h2>
      <p style={{ margin: 0, marginBottom: 16, color: "#94A3B8", fontSize: 12 }}>
        Manage dropdown options used in the costing grid.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16, maxWidth: 1200 }}>
        {SECTIONS.map((s) => (
          <MasterCard key={s.kind} kind={s.kind} title={s.title} description={s.description} placeholder={s.placeholder} entries={masters[s.kind] || []} />
        ))}
        <FreeformCard
          kind="colors"
          title="Color Master (freeform)"
          description="Operator-typed colors only. Auto-deleted when the same color appears in ip_item_master (Xoro sync). Click an entry to edit; × removes."
          placeholder="e.g. STORMY WEATHER"
          entries={extraColors}
        />
        <FreeformCard
          kind="vendors"
          title="Vendor Master (freeform)"
          description="Operator-added vendors only. Auto-deleted when the same name appears in ip_vendor_master or canonical vendors via Xoro sync. Click to edit; × removes (the underlying vendors row stays — manage it elsewhere)."
          placeholder="e.g. HEMAYET FACTORY"
          entries={extraVendors}
        />
      </div>
    </div>
  );
}

function FreeformCard({ kind, title, description, placeholder, entries }: { kind: "colors" | "vendors"; title: string; description: string; placeholder: string; entries: string[] }) {
  const addColor    = useCostingStore((s) => s.addExtraColor);
  const addVendor   = useCostingStore((s) => s.addExtraVendor);
  const renameColor = useCostingStore((s) => s.renameExtraColor);
  const renameVendor = useCostingStore((s) => s.renameExtraVendor);
  const deleteColor = useCostingStore((s) => s.deleteExtraColor);
  const deleteVendor = useCostingStore((s) => s.deleteExtraVendor);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const add    = kind === "colors" ? addColor    : addVendor;
  const rename = kind === "colors" ? renameColor : renameVendor;
  const remove = kind === "colors" ? deleteColor : deleteVendor;

  const onAdd = async () => {
    const v = draft.trim();
    if (!v) return;
    await add(v);
    setDraft("");
  };

  const onCommitEdit = async (oldName: string) => {
    const v = editValue.trim();
    if (!v || v.toLowerCase() === oldName.toLowerCase()) { setEditing(null); return; }
    await rename(oldName, v);
    setEditing(null);
  };

  return (
    <div style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 8, padding: "14px 16px" }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#E2E8F0", marginBottom: 4, letterSpacing: ".02em" }}>{title}</div>
      <div style={{ fontSize: 11, color: "#94A3B8", marginBottom: 10, lineHeight: 1.4 }}>{description}</div>

      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onAdd(); }}
          placeholder={placeholder}
          style={{
            flex: 1, background: "#0F172A", color: "#E2E8F0",
            border: "1px solid #334155", borderRadius: 4, padding: "5px 8px",
            fontSize: 12, outline: "none",
          }}
        />
        <button
          onClick={onAdd}
          disabled={!draft.trim()}
          style={{
            background: "#10B981", color: "#fff", border: "none",
            padding: "5px 12px", borderRadius: 4, cursor: draft.trim() ? "pointer" : "not-allowed",
            fontSize: 12, fontWeight: 600, opacity: draft.trim() ? 1 : 0.55,
          }}
        >Add</button>
      </div>

      {entries.length === 0 && (
        <div style={{ color: "#64748B", fontSize: 11, fontStyle: "italic", padding: "8px 4px" }}>
          No entries. Anything you type into a grid Color or Vendor cell shows up here automatically.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {entries.map((name) => (
          <div key={name} style={{
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6,
            background: "#0F172A", border: "1px solid #1F2937", borderRadius: 4, padding: "5px 8px",
          }}>
            {editing === name ? (
              <input
                autoFocus
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void onCommitEdit(name);
                  if (e.key === "Escape") setEditing(null);
                }}
                onBlur={() => void onCommitEdit(name)}
                style={{
                  flex: 1, background: "#1E293B", color: "#E2E8F0",
                  border: "1px solid #475569", borderRadius: 3, padding: "2px 6px",
                  fontSize: 12, outline: "none",
                }}
              />
            ) : (
              <span
                onClick={() => { setEditing(name); setEditValue(name); }}
                title="Click to rename"
                style={{ fontSize: 12, color: "#E2E8F0", cursor: "text", flex: 1 }}
              >{name}</span>
            )}
            <button
              onClick={() => appConfirm(`Remove "${name}" from the ${kind === "colors" ? "color" : "vendor"} master?`, "Remove", () => remove(name))}
              style={{
                background: "transparent", color: "#EF4444",
                border: "1px solid #EF4444", borderRadius: 3,
                padding: "1px 8px", cursor: "pointer", fontSize: 11,
              }}
            >×</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function MasterCard({ kind, title, description, placeholder, entries }: { kind: MasterKind; title: string; description: string; placeholder: string; entries: MasterEntry[] }) {
  const add    = useCostingStore((s) => s.addMaster);
  const update = useCostingStore((s) => s.updateMaster);
  const remove = useCostingStore((s) => s.deleteMaster);
  const [draft, setDraft] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const onAdd = async () => {
    const v = draft.trim();
    if (!v) return;
    await add(kind, v);
    setDraft("");
  };

  const startEdit = (e: MasterEntry) => { setEditId(e.id); setEditText(e.name); };
  const cancelEdit = () => { setEditId(null); setEditText(""); };
  const saveEdit = async () => {
    const v = editText.trim();
    if (v && editId) await update(kind, editId, v);
    cancelEdit();
  };

  return (
    <div style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 8, padding: "14px 16px" }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#E2E8F0", marginBottom: 4, letterSpacing: ".02em" }}>{title}</div>
      <div style={{ fontSize: 11, color: "#94A3B8", marginBottom: 10, lineHeight: 1.4 }}>{description}</div>

      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onAdd(); }}
          placeholder={placeholder}
          style={{
            flex: 1, background: "#0F172A", color: "#E2E8F0",
            border: "1px solid #334155", borderRadius: 4, padding: "5px 8px",
            fontSize: 12, outline: "none",
          }}
        />
        <button
          onClick={onAdd}
          disabled={!draft.trim()}
          style={{
            background: "#10B981", color: "#fff", border: "none",
            padding: "5px 12px", borderRadius: 4, cursor: draft.trim() ? "pointer" : "not-allowed",
            fontSize: 12, fontWeight: 600, opacity: draft.trim() ? 1 : 0.55,
          }}
        >Add</button>
      </div>

      {entries.length === 0 && (
        <div style={{ color: "#64748B", fontSize: 11, fontStyle: "italic", padding: "8px 4px" }}>
          No entries yet. Add one above.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {entries.map((e) => (
          <div key={e.id} style={{
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6,
            background: "#0F172A", border: "1px solid #1F2937", borderRadius: 4, padding: "5px 8px",
          }}>
            {editId === e.id ? (
              <>
                <input
                  autoFocus
                  value={editText}
                  onChange={(ev) => setEditText(ev.target.value)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") saveEdit();
                    if (ev.key === "Escape") cancelEdit();
                  }}
                  style={{
                    flex: 1, background: "#0F172A", color: "#E2E8F0",
                    border: "1px solid #334155", borderRadius: 4, padding: "3px 6px",
                    fontSize: 12, outline: "none",
                  }}
                />
                <button
                  onClick={saveEdit}
                  disabled={!editText.trim()}
                  style={{
                    background: "#10B981", color: "#fff", border: "none",
                    borderRadius: 3, padding: "2px 8px",
                    cursor: editText.trim() ? "pointer" : "not-allowed",
                    fontSize: 11, fontWeight: 600, opacity: editText.trim() ? 1 : 0.55,
                  }}
                >Save</button>
                <button
                  onClick={cancelEdit}
                  style={{
                    background: "transparent", color: "#94A3B8",
                    border: "1px solid #334155", borderRadius: 3,
                    padding: "2px 8px", cursor: "pointer", fontSize: 11,
                  }}
                >Cancel</button>
              </>
            ) : (
              <>
                <span
                  onClick={() => startEdit(e)}
                  title="Click to edit"
                  style={{ flex: 1, fontSize: 12, color: "#E2E8F0", cursor: "pointer" }}
                >{e.name}</span>
                <button
                  onClick={() => startEdit(e)}
                  title="Edit"
                  style={{
                    background: "transparent", color: "#60A5FA",
                    border: "1px solid #60A5FA", borderRadius: 3,
                    padding: "1px 8px", cursor: "pointer", fontSize: 11,
                  }}
                >Edit</button>
                <button
                  onClick={() => appConfirm(`Remove "${e.name}"?`, "Remove", () => remove(kind, e.id))}
                  style={{
                    background: "transparent", color: "#EF4444",
                    border: "1px solid #EF4444", borderRadius: 3,
                    padding: "1px 8px", cursor: "pointer", fontSize: 11,
                  }}
                >×</button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
