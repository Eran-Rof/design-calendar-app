// Add / Edit Material modal extracted from TechPack.tsx. A focused
// form bound to the parent's matForm state — the Save button is
// disabled until `name` is non-empty.
//
// The actual save logic (CSV-split for certifications, id/createdAt
// preservation on edit) lives in materialFromForm in ../factories.ts
// and runs inside the parent's handleSaveMaterial. This component
// just renders the form + delegates state writes.

import type { Material } from "../types";
import type { MaterialFormValues } from "../factories";
import { MATERIAL_TYPES } from "../constants";
import SearchableSelect from "../../tanda/components/SearchableSelect";
import S from "../styles";

export interface MaterialModalProps {
  matForm: MaterialFormValues;
  setMatForm: (next: MaterialFormValues | ((cur: MaterialFormValues) => MaterialFormValues)) => void;
  editingMaterial: Material | null;
  onClose: () => void;
  onSave: () => void;
}

export function MaterialModal({
  matForm,
  setMatForm,
  editingMaterial,
  onClose,
  onSave,
}: MaterialModalProps) {
  const isEditing = editingMaterial !== null;

  return (
    <div style={S.modalOverlay} onClick={onClose}>
      <div style={{ ...S.modal, width: 520 }} onClick={e => e.stopPropagation()}>
        <div style={S.modalHeader}>
          <h2 style={S.modalTitle}>{isEditing ? "Edit Material" : "Add Material"}</h2>
          <button style={S.closeBtn} onClick={onClose}>✕</button>
        </div>
        <div style={S.modalBody}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div>
              <label style={S.label}>Name *</label>
              <input style={S.input} value={matForm.name} onChange={e => setMatForm(f => ({ ...f, name: e.target.value }))} placeholder="Material name" />
            </div>
            <div>
              <label style={S.label}>Type</label>
              <SearchableSelect
                value={matForm.type || null}
                onChange={v => setMatForm(f => ({ ...f, type: v }))}
                options={MATERIAL_TYPES.map(t => ({ value: t, label: t }))}
                inputStyle={{ ...S.select, width: "100%" }}
              />
            </div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={S.label}>Composition</label>
            <input style={S.input} value={matForm.composition} onChange={e => setMatForm(f => ({ ...f, composition: e.target.value }))} placeholder="e.g. 100% Cotton" />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div>
              <label style={S.label}>Weight</label>
              <input style={S.input} value={matForm.weight} onChange={e => setMatForm(f => ({ ...f, weight: e.target.value }))} placeholder="e.g. 180 GSM" />
            </div>
            <div>
              <label style={S.label}>Width</label>
              <input style={S.input} value={matForm.width} onChange={e => setMatForm(f => ({ ...f, width: e.target.value }))} placeholder='e.g. 58"' />
            </div>
            <div>
              <label style={S.label}>Color</label>
              <input style={S.input} value={matForm.color} onChange={e => setMatForm(f => ({ ...f, color: e.target.value }))} placeholder="Color" />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div>
              <label style={S.label}>Supplier</label>
              <input style={S.input} value={matForm.supplier} onChange={e => setMatForm(f => ({ ...f, supplier: e.target.value }))} placeholder="Supplier name" />
            </div>
            <div>
              <label style={S.label}>Unit Price ($)</label>
              <input style={S.input} type="number" step="0.01" value={matForm.unitPrice || ""} onChange={e => setMatForm(f => ({ ...f, unitPrice: parseFloat(e.target.value) || 0 }))} />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div>
              <label style={S.label}>MOQ</label>
              <input style={S.input} value={matForm.moq} onChange={e => setMatForm(f => ({ ...f, moq: e.target.value }))} placeholder="Min order qty" />
            </div>
            <div>
              <label style={S.label}>Lead Time</label>
              <input style={S.input} value={matForm.leadTime} onChange={e => setMatForm(f => ({ ...f, leadTime: e.target.value }))} placeholder="e.g. 4 weeks" />
            </div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={S.label}>Certifications (comma separated)</label>
            <input style={S.input} value={matForm.certifications} onChange={e => setMatForm(f => ({ ...f, certifications: e.target.value }))} placeholder="e.g. OEKO-TEX, GOTS, BCI" />
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={S.label}>Notes</label>
            <textarea style={{ ...S.textarea, minHeight: 50 }} value={matForm.notes} onChange={e => setMatForm(f => ({ ...f, notes: e.target.value }))} />
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button style={{ ...S.btnSecondary, flex: 1 }} onClick={onClose}>Cancel</button>
            <button
              style={{ ...S.btnPrimary, flex: 2, opacity: !matForm.name ? 0.5 : 1 }}
              disabled={!matForm.name}
              onClick={onSave}
            >
              {isEditing ? "Update Material" : "Add Material"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
