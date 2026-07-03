// New Spec Sheet modal extracted from TechPack.tsx. Same metadata-form
// shape as the CreateModal but for spec sheets rather than tech packs,
// plus a size-presets row + optional "from template" banner.
//
// The actual creation (assembling the SpecSheet, splitting sizes,
// cloning template rows) happens inside onCreate which the parent
// provides. Keeps this component a pure form-renderer.

import type { SpecSheet, SpecTemplate } from "../types";
import type { SpecSheetFormValues } from "../factories";
import { subCategoriesFor, type CategoryLike } from "../listLogic";
import { SIZE_PRESETS } from "../constants";
import SearchableSelect from "../../tanda/components/SearchableSelect";
import S from "../styles";

interface DCBrand { name: string; }
interface DCVendor { name: string; }

export interface SpecSheetModalProps {
  ssForm: SpecSheetFormValues;
  setSsForm: (next: SpecSheetFormValues | ((cur: SpecSheetFormValues) => SpecSheetFormValues)) => void;
  activeTemplate: SpecTemplate | null;
  setActiveTemplate: (t: SpecTemplate | null) => void;
  dcBrands: DCBrand[];
  dcSeasons: string[];
  dcCategories: CategoryLike[];
  dcGenders: string[];
  dcVendors: DCVendor[];
  onClose: () => void;
  /**
   * Build the SpecSheet from `ssForm` (+ activeTemplate if set), append
   * to specSheets, select it. Parent owns the persistence logic so
   * tests don't have to wire up Supabase.
   */
  onCreate: () => SpecSheet;
}

export function SpecSheetModal({
  ssForm,
  setSsForm,
  activeTemplate,
  setActiveTemplate,
  dcBrands,
  dcSeasons,
  dcCategories,
  dcGenders,
  dcVendors,
  onClose,
  onCreate,
}: SpecSheetModalProps) {
  const selectStyle = { ...S.input, appearance: "none" as const };
  const subCats = subCategoriesFor(dcCategories, ssForm.category);
  const cannotCreate = !ssForm.styleName;

  return (
    <div style={S.modalOverlay} onClick={onClose}>
      <div style={{ ...S.modal, width: 560 }} onClick={e => e.stopPropagation()}>
        <div style={S.modalHeader}>
          <div>
            <h2 style={{ ...S.modalTitle, margin: 0 }}>New Spec Sheet</h2>
            {activeTemplate && (
              <div style={{ fontSize: 12, color: "#60A5FA", marginTop: 4, display: "flex", alignItems: "center", gap: 6 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                  <rect x="3" y="3" width="7" height="7" rx="1.5" stroke="#60A5FA" strokeWidth="2"/>
                  <rect x="14" y="3" width="7" height="7" rx="1.5" stroke="#60A5FA" strokeWidth="2"/>
                  <rect x="3" y="14" width="7" height="7" rx="1.5" stroke="#60A5FA" strokeWidth="2"/>
                  <rect x="14" y="14" width="7" height="7" rx="1.5" stroke="#60A5FA" strokeWidth="2"/>
                </svg>
                Using template: <strong>{activeTemplate.name}</strong>
                <button
                  style={{ background: "none", border: "none", color: "#EF4444", cursor: "pointer", fontSize: 11, padding: "0 2px" }}
                  onClick={() => setActiveTemplate(null)}
                >✕ Clear</button>
              </div>
            )}
          </div>
          <button style={S.closeBtn} onClick={() => { onClose(); setActiveTemplate(null); }}>✕</button>
        </div>
        <div style={S.modalBody}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div>
              <label style={S.label}>Style Name *</label>
              <input style={S.input} value={ssForm.styleName} onChange={e => setSsForm(f => ({ ...f, styleName: e.target.value }))} placeholder="e.g. Classic Oxford" autoFocus />
            </div>
            <div>
              <label style={S.label}>Style Number</label>
              <input style={S.input} value={ssForm.styleNumber} onChange={e => setSsForm(f => ({ ...f, styleNumber: e.target.value }))} placeholder="e.g. OXF-001" />
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div>
              <label style={S.label}>Brand</label>
              {dcBrands.length > 0 ? (
                <SearchableSelect
                  value={ssForm.brand || null}
                  onChange={v => setSsForm(f => ({ ...f, brand: v }))}
                  options={dcBrands.map(b => ({ value: b.name, label: b.name }))}
                  placeholder="— select brand —"
                  inputStyle={selectStyle}
                />
              ) : (
                <input style={S.input} value={ssForm.brand} onChange={e => setSsForm(f => ({ ...f, brand: e.target.value }))} />
              )}
            </div>
            <div>
              <label style={S.label}>Season</label>
              {dcSeasons.length > 0 ? (
                <SearchableSelect
                  value={ssForm.season || null}
                  onChange={v => setSsForm(f => ({ ...f, season: v }))}
                  options={dcSeasons.map(s => ({ value: s, label: s }))}
                  placeholder="— select season —"
                  inputStyle={selectStyle}
                />
              ) : (
                <input style={S.input} value={ssForm.season} onChange={e => setSsForm(f => ({ ...f, season: e.target.value }))} />
              )}
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div>
              <label style={S.label}>Category</label>
              {dcCategories.length > 0 ? (
                <SearchableSelect
                  value={ssForm.category || null}
                  onChange={v => setSsForm(f => ({ ...f, category: v, subCategory: "" }))}
                  options={dcCategories.map(c => ({ value: c.name, label: c.name }))}
                  placeholder="— select category —"
                  inputStyle={selectStyle}
                />
              ) : (
                <input style={S.input} value={ssForm.category} onChange={e => setSsForm(f => ({ ...f, category: e.target.value }))} />
              )}
            </div>
            {subCats.length > 0 && (
              <div>
                <label style={S.label}>Sub-Category</label>
                <SearchableSelect
                  value={ssForm.subCategory || null}
                  onChange={v => setSsForm(f => ({ ...f, subCategory: v }))}
                  options={subCats.map(sc => ({ value: sc, label: sc }))}
                  placeholder="— select sub-category —"
                  inputStyle={selectStyle}
                />
              </div>
            )}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div>
              <label style={S.label}>Gender</label>
              {dcGenders.length > 0 ? (
                <SearchableSelect
                  value={ssForm.gender || null}
                  onChange={v => setSsForm(f => ({ ...f, gender: v }))}
                  options={dcGenders.map(g => ({ value: g, label: g }))}
                  placeholder="— select gender —"
                  inputStyle={selectStyle}
                />
              ) : (
                <input style={S.input} value={ssForm.gender} onChange={e => setSsForm(f => ({ ...f, gender: e.target.value }))} />
              )}
            </div>
            <div>
              <label style={S.label}>Vendor</label>
              {dcVendors.length > 0 ? (
                <SearchableSelect
                  value={ssForm.vendor || null}
                  onChange={v => setSsForm(f => ({ ...f, vendor: v }))}
                  options={dcVendors.map(v => ({ value: v.name, label: v.name }))}
                  placeholder="— select vendor —"
                  inputStyle={selectStyle}
                />
              ) : (
                <input style={S.input} value={ssForm.vendor} onChange={e => setSsForm(f => ({ ...f, vendor: e.target.value }))} />
              )}
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={S.label}>Description</label>
            <input style={S.input} value={ssForm.description} onChange={e => setSsForm(f => ({ ...f, description: e.target.value }))} />
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={S.label}>Sizes</label>
            <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 6, marginBottom: 8 }}>
              {SIZE_PRESETS.map(p => (
                <button
                  key={p.label}
                  style={{ ...S.btnSmall, fontSize: 11 }}
                  onClick={() => setSsForm(f => ({ ...f, sizes: p.sizes.join(", ") }))}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <input style={S.input} value={ssForm.sizes} onChange={e => setSsForm(f => ({ ...f, sizes: e.target.value }))} placeholder="XS, S, M, L, XL, XXL" />
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button style={{ ...S.btnSecondary, flex: 1 }} onClick={onClose}>Cancel</button>
            <button
              style={{ ...S.btnPrimary, flex: 2, opacity: cannotCreate ? 0.5 : 1 }}
              disabled={cannotCreate}
              onClick={() => onCreate()}
            >
              {activeTemplate ? `Create from "${activeTemplate.name}"` : "Create Spec Sheet"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
