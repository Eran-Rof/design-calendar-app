// Materials library view extracted from TechPack.tsx. Filterable
// table of materials (search + type dropdown) with Excel download +
// + Add Material affordances. Edit + Delete affordances per row.
//
// Filtering goes through ../listLogic.filterMaterials (already
// covered by 10 unit tests). Delete uses the parent's confirm
// dialog state.

import type { Material } from "../types";
import { fmtCurrency } from "../utils";
import { filterMaterials } from "../listLogic";
import { MATERIAL_TYPES } from "../constants";
import { EMPTY_MATERIAL_FORM, type MaterialFormValues } from "../factories";
import SearchableSelect from "../../tanda/components/SearchableSelect";
import S from "../styles";

export interface MaterialsViewProps {
  materials: Material[];
  matSearch: string;
  setMatSearch: (s: string) => void;
  matTypeFilter: string;
  setMatTypeFilter: (s: string) => void;
  setEditingMaterial: (m: Material | null) => void;
  setMatForm: (f: MaterialFormValues) => void;
  setShowMaterialModal: (b: boolean) => void;
  setConfirmDialog: (d: { title: string; message: string; onConfirm: () => void } | null) => void;
  saveMaterials: (mats: Material[]) => Promise<void> | void;
  downloadMaterialsExcel: (mats: Material[]) => void;
}

export function MaterialsView({
  materials,
  matSearch,
  setMatSearch,
  matTypeFilter,
  setMatTypeFilter,
  setEditingMaterial,
  setMatForm,
  setShowMaterialModal,
  setConfirmDialog,
  saveMaterials,
  downloadMaterialsExcel,
}: MaterialsViewProps) {
  const filteredMats = filterMaterials(materials, { type: matTypeFilter, search: matSearch });

  const openEditModal = (m: Material) => {
    setEditingMaterial(m);
    setMatForm({
      name: m.name, type: m.type, composition: m.composition, weight: m.weight,
      width: m.width, color: m.color, supplier: m.supplier, unitPrice: m.unitPrice,
      moq: m.moq, leadTime: m.leadTime,
      certifications: m.certifications.join(", "),
      notes: m.notes,
    });
    setShowMaterialModal(true);
  };

  const openCreateModal = () => {
    setEditingMaterial(null);
    setMatForm(EMPTY_MATERIAL_FORM);
    setShowMaterialModal(true);
  };

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: "#F1F5F9", fontSize: 22 }}>Materials Library</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => downloadMaterialsExcel(materials)}
            style={{ background: "#1D6F42", border: "none", borderRadius: 6, padding: "6px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, color: "#fff", fontSize: 12, fontWeight: 600, fontFamily: "inherit", transition: "background 0.15s" }}
            onMouseEnter={e => e.currentTarget.style.background = "#155734"}
            onMouseLeave={e => e.currentTarget.style.background = "#1D6F42"}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" fill="#fff" fillOpacity=".2" stroke="#fff" strokeWidth="1.5"/><path d="M14 2v6h6" stroke="#fff" strokeWidth="1.5"/><path d="M8 13l2.5 4M8 17l2.5-4M13 13v4M15.5 13v4M13 15h2.5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            Excel
          </button>
          <button style={S.btnPrimarySmall} onClick={openCreateModal}>+ Add Material</button>
        </div>
      </div>

      <div style={S.filters}>
        <input
          style={{ ...S.input, maxWidth: 300 }}
          placeholder="Search materials..."
          value={matSearch}
          onChange={e => setMatSearch(e.target.value)}
        />
        <SearchableSelect
          value={matTypeFilter || null}
          onChange={v => setMatTypeFilter(v)}
          options={[{ value: "", label: "All Types" }, ...MATERIAL_TYPES.map(t => ({ value: t, label: t }))]}
          placeholder="All Types"
          inputStyle={S.select}
        />
        <span style={{ color: "#6B7280", fontSize: 13 }}>{filteredMats.length} materials</span>
      </div>

      {filteredMats.length === 0 ? (
        <div style={S.emptyState}>
          <p>No materials found. Add your first material!</p>
        </div>
      ) : (
        <div style={S.tableWrap}>
          <div style={S.tableHeader}>
            <span style={{ flex: 2 }}>Name</span>
            <span style={{ flex: 1 }}>Type</span>
            <span style={{ flex: 2 }}>Composition</span>
            <span style={{ flex: 1 }}>Weight</span>
            <span style={{ flex: 1 }}>Supplier</span>
            <span style={{ flex: 1 }}>Price</span>
            <span style={{ flex: 1 }}>Certs</span>
            <span style={{ width: 60 }}>Actions</span>
          </div>
          {filteredMats.map((m, i) => (
            <div key={m.id} style={{ ...S.tableRow, background: i % 2 === 0 ? "#0F172A" : "#1A2332" }}>
              <span style={{ flex: 2, color: "#60A5FA", fontWeight: 600 }}>{m.name}</span>
              <span style={{ flex: 1, color: "#94A3B8" }}>{m.type}</span>
              <span style={{ flex: 2, color: "#D1D5DB" }}>{m.composition}</span>
              <span style={{ flex: 1, color: "#94A3B8" }}>{m.weight}</span>
              <span style={{ flex: 1, color: "#94A3B8" }}>{m.supplier}</span>
              <span style={{ flex: 1, color: "#10B981", fontWeight: 600 }}>{fmtCurrency(m.unitPrice)}</span>
              <span style={{ flex: 1 }}>
                {m.certifications.map(c => (
                  <span key={c} style={{ ...S.badge, background: "#10B98122", color: "#10B981", border: "1px solid #10B98144", marginRight: 4 }}>{c}</span>
                ))}
              </span>
              <span style={{ width: 60, display: "flex", gap: 4 }}>
                <button style={S.iconBtn} onClick={() => openEditModal(m)}>Edit</button>
                <button
                  style={S.iconBtn}
                  onClick={() => setConfirmDialog({
                    title: "Delete Material",
                    message: `Delete "${m.name}"? This cannot be undone.`,
                    onConfirm: () => { void saveMaterials(materials.filter(x => x.id !== m.id)); },
                  })}
                >Delete</button>
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
