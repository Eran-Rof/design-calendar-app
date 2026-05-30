// Costing Module — Settings / Masters view.
//
// Lets the operator manage the small attribute lists used by grid cell
// dropdowns: Fit, Closure, Waist, Comment templates. Color is not managed
// here — its options derive from ip_item_master.color via
// /api/internal/costing/search/colors plus user-added extras.

import React, { useEffect, useState } from "react";
import { useCostingStore, type MasterKind, type MasterEntry } from "../store/costingStore";
import { appConfirm } from "../../utils/theme";

const SECTIONS: { kind: MasterKind; title: string; description: string; placeholder: string }[] = [
  { kind: "fit",     title: "Fit",     description: "Fit options for the grid (Standard, Relaxed, Slim, …).", placeholder: "e.g. Relaxed" },
  { kind: "closure", title: "Bottom Closure", description: "Closure options (Jogger, Open Bottom, Drawstring, …).", placeholder: "e.g. Jogger" },
  { kind: "waist",   title: "Waist Type", description: "Waist construction (E-Waist, Fixed, Drawstring, …).", placeholder: "e.g. E-Waist" },
  { kind: "comment", title: "Comment Templates", description: "Reusable comment snippets the operator can insert into a line.", placeholder: 'e.g. "Please make E/W"' },
];

export default function SettingsView() {
  const masters = useCostingStore((s) => s.masters);
  const load    = useCostingStore((s) => s.loadMasters);

  useEffect(() => { load(); }, [load]);

  return (
    <div style={{ padding: "20px 24px", background: "#0F172A", minHeight: "100%", color: "#E2E8F0" }}>
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Costing Masters</h2>
      <p style={{ margin: 0, marginBottom: 16, color: "#94A3B8", fontSize: 12 }}>
        Manage dropdown options used in the costing grid. Color autocomplete is sourced from existing SKUs in <code>ip_item_master</code>; new colors typed in the grid are automatically remembered.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16, maxWidth: 1200 }}>
        {SECTIONS.map((s) => (
          <MasterCard key={s.kind} kind={s.kind} title={s.title} description={s.description} placeholder={s.placeholder} entries={masters[s.kind] || []} />
        ))}
      </div>
    </div>
  );
}

function MasterCard({ kind, title, description, placeholder, entries }: { kind: MasterKind; title: string; description: string; placeholder: string; entries: MasterEntry[] }) {
  const add    = useCostingStore((s) => s.addMaster);
  const remove = useCostingStore((s) => s.deleteMaster);
  const [draft, setDraft] = useState("");

  const onAdd = async () => {
    const v = draft.trim();
    if (!v) return;
    await add(kind, v);
    setDraft("");
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
            display: "flex", alignItems: "center", justifyContent: "space-between",
            background: "#0F172A", border: "1px solid #1F2937", borderRadius: 4, padding: "5px 8px",
          }}>
            <span style={{ fontSize: 12, color: "#E2E8F0" }}>{e.name}</span>
            <button
              onClick={() => appConfirm(`Remove "${e.name}"?`, "Remove", () => remove(kind, e.id))}
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
