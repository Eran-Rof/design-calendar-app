// Create Tech Pack modal extracted from TechPack.tsx. Multi-field
// form with Brand + Season inline quick-add buttons + Tech Designer/
// Graphic Artist/Product Developer/Designer team-member dropdowns.
//
// All Design Calendar reference data (brands, seasons, genders,
// vendors, categories, team) comes in as props. The Brand + Season
// quick-add handlers also flow back through props (addBrand /
// addSeason) so the parent can persist them via dcSave.
//
// The `openTeamDrop` state — which team-member dropdown is currently
// open — is kept LOCAL to this component because the parent doesn't
// need it for anything else. Was previously hoisted to the parent
// only because the inline IIFE couldn't have its own useState.

import { useState } from "react";
import type { CreateTechPackFormValues } from "../factories";
import { subCategoriesFor, type CategoryLike } from "../listLogic";
import { CATEGORIES } from "../constants";
import S from "../styles";

interface DCBrand { id: string; name: string; }
interface DCVendor { id: string; name: string; country?: string; }
interface DCTeamMember {
  id: string;
  name: string;
  role?: string;
  avatar?: string;
  color?: string;
  initials?: string;
}

type TeamMemberField = "techDesigner" | "graphicArtist" | "productDeveloper" | "designer";

export interface CreateModalProps {
  createForm: CreateTechPackFormValues;
  setCreateForm: (next: CreateTechPackFormValues | ((cur: CreateTechPackFormValues) => CreateTechPackFormValues)) => void;
  dcBrands: DCBrand[];
  dcSeasons: string[];
  dcGenders: string[];
  dcVendors: DCVendor[];
  dcCategories: CategoryLike[];
  dcTeam: DCTeamMember[];
  /** Opens a name-prompt + persists the new brand; closes by selecting it. */
  onAddBrand: () => void;
  /** Same shape as onAddBrand but for seasons. */
  onAddSeason: () => void;
  onClose: () => void;
  onCreate: () => void;
}

export function CreateModal({
  createForm,
  setCreateForm,
  dcBrands,
  dcSeasons,
  dcGenders,
  dcVendors,
  dcCategories,
  dcTeam,
  onAddBrand,
  onAddSeason,
  onClose,
  onCreate,
}: CreateModalProps) {
  const subCats = subCategoriesFor(dcCategories, createForm.category);
  // Which team-member dropdown is currently open. Local UI state —
  // parent didn't need it for anything else.
  const [openTeamDrop, setOpenTeamDrop] = useState<TeamMemberField | null>(null);

  // Renders one of the 4 team-member picker dropdowns. Inlined as a
  // closure so it can capture the parent's createForm + setters
  // without another set of props.
  const TeamMemberSelect = ({ field, label }: { field: TeamMemberField; label: string }) => {
    const val = createForm[field];
    const member = dcTeam.find(m => m.name === val);
    const isOpen = openTeamDrop === field;
    return (
      <div style={{ position: "relative" }}>
        <label style={S.label}>{label}</label>
        <button
          type="button"
          style={{ ...S.input, display: "flex", alignItems: "center", gap: 8, cursor: "pointer", textAlign: "left" as any }}
          onClick={() => setOpenTeamDrop(isOpen ? null : field)}
        >
          {member ? (
            <>
              {member.avatar
                ? <img src={member.avatar} style={{ width: 22, height: 22, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
                : <div style={{ width: 22, height: 22, borderRadius: "50%", background: member.color || "#3B82F6", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: "#fff", flexShrink: 0 }}>{member.initials || member.name?.[0] || "?"}</div>
              }
              <span style={{ fontSize: 13, color: "#F1F5F9" }}>{member.name}</span>
              <span style={{ fontSize: 11, color: "#6B7280", marginLeft: "auto" }}>{member.role}</span>
            </>
          ) : (
            <span style={{ color: "#4B5563", fontSize: 13 }}>Select {label}...</span>
          )}
          <span style={{ marginLeft: "auto", color: "#6B7280", fontSize: 10 }}>▾</span>
        </button>
        {isOpen && (
          <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, background: "#1E293B", border: "1px solid #334155", borderRadius: 10, zIndex: 300, maxHeight: 220, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,.5)" }}>
            <div
              style={{ padding: "6px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, color: "#6B7280", fontSize: 12, borderBottom: "1px solid #334155" }}
              onClick={() => { setCreateForm(f => ({ ...f, [field]: "" })); setOpenTeamDrop(null); }}
            >
              — None —
            </div>
            {dcTeam.map(m => (
              <div
                key={m.id}
                style={{ padding: "8px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, transition: "background .1s" }}
                onMouseEnter={e => (e.currentTarget.style.background = "#334155")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                onClick={() => { setCreateForm(f => ({ ...f, [field]: m.name })); setOpenTeamDrop(null); }}
              >
                {m.avatar
                  ? <img src={m.avatar} style={{ width: 28, height: 28, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
                  : <div style={{ width: 28, height: 28, borderRadius: "50%", background: m.color || "#3B82F6", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#fff", flexShrink: 0 }}>{m.initials || m.name?.[0] || "?"}</div>
                }
                <div>
                  <div style={{ color: "#F1F5F9", fontSize: 13, fontWeight: 600 }}>{m.name}</div>
                  <div style={{ color: "#6B7280", fontSize: 11 }}>{m.role}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const cannotCreate = !createForm.styleName || !createForm.styleNumber;

  return (
    <div style={S.modalOverlay} onClick={() => { onClose(); setOpenTeamDrop(null); }}>
      <div style={{ ...S.modal, width: 620, maxWidth: "95vw" }} onClick={e => e.stopPropagation()}>
        <div style={S.modalHeader}>
          <h2 style={S.modalTitle}>Create Tech Pack</h2>
          <button style={S.closeBtn} onClick={onClose}>✕</button>
        </div>
        <div style={S.modalBody}>

          {/* Row 1: Style Number + Style Name */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div>
              <label style={S.label}>Style Number *</label>
              <input style={S.input} value={createForm.styleNumber} onChange={e => setCreateForm(f => ({ ...f, styleNumber: e.target.value }))} placeholder="e.g. OXF-001" autoFocus />
            </div>
            <div>
              <label style={S.label}>Style Name *</label>
              <input style={S.input} value={createForm.styleName} onChange={e => setCreateForm(f => ({ ...f, styleName: e.target.value }))} placeholder="e.g. Classic Oxford Shirt" />
            </div>
          </div>

          {/* Row 2: Brand + Season */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div>
              <label style={S.label}>Brand</label>
              <div style={{ display: "flex", gap: 6 }}>
                <select style={{ ...S.select, flex: 1 }} value={createForm.brand} onChange={e => setCreateForm(f => ({ ...f, brand: e.target.value }))}>
                  <option value="">Select brand...</option>
                  {dcBrands.map(b => <option key={b.id} value={b.name}>{b.name}</option>)}
                </select>
                <button style={S.btnSmall} title="Add new brand" onClick={onAddBrand}>+</button>
              </div>
            </div>
            <div>
              <label style={S.label}>Season</label>
              <div style={{ display: "flex", gap: 6 }}>
                <select style={{ ...S.select, flex: 1 }} value={createForm.season} onChange={e => setCreateForm(f => ({ ...f, season: e.target.value }))}>
                  <option value="">Select season...</option>
                  {dcSeasons.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <button style={S.btnSmall} title="Add new season" onClick={onAddSeason}>+</button>
              </div>
            </div>
          </div>

          {/* Row 3: Gender + Vendor */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div>
              <label style={S.label}>Gender</label>
              <select style={{ ...S.select, width: "100%" }} value={createForm.gender} onChange={e => setCreateForm(f => ({ ...f, gender: e.target.value }))}>
                <option value="">Select gender...</option>
                {dcGenders.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
            <div>
              <label style={S.label}>Vendor</label>
              <select style={{ ...S.select, width: "100%" }} value={createForm.vendor} onChange={e => setCreateForm(f => ({ ...f, vendor: e.target.value }))}>
                <option value="">Select vendor...</option>
                {dcVendors.map(v => <option key={v.id} value={v.name}>{v.name}{v.country ? ` (${v.country})` : ""}</option>)}
              </select>
            </div>
          </div>

          {/* Row 4: Category + Sub Category */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div>
              <label style={S.label}>Category</label>
              <select style={{ ...S.select, width: "100%" }} value={createForm.category} onChange={e => setCreateForm(f => ({ ...f, category: e.target.value, subCategory: "" }))}>
                <option value="">Select category...</option>
                {dcCategories.length > 0
                  ? dcCategories.map((c: any) => <option key={c.id ?? c.name} value={c.name}>{c.name}</option>)
                  : CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)
                }
              </select>
            </div>
            <div>
              <label style={S.label}>Sub Category</label>
              <select style={{ ...S.select, width: "100%", opacity: subCats.length === 0 ? 0.5 : 1 }} value={createForm.subCategory} onChange={e => setCreateForm(f => ({ ...f, subCategory: e.target.value }))} disabled={subCats.length === 0}>
                <option value="">{subCats.length === 0 ? "Select category first" : "Select sub category..."}</option>
                {subCats.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          {/* Row 5: Tech Designer + Graphic Artist */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <TeamMemberSelect field="techDesigner" label="Tech Designer" />
            <TeamMemberSelect field="graphicArtist" label="Graphic Artist" />
          </div>

          {/* Row 6: Product Developer + Designer */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <TeamMemberSelect field="productDeveloper" label="Product Developer" />
            <TeamMemberSelect field="designer" label="Designer" />
          </div>

          {/* Description */}
          <div style={{ marginBottom: 16 }}>
            <label style={S.label}>Description</label>
            <textarea style={{ ...S.textarea, minHeight: 56 }} value={createForm.description} onChange={e => setCreateForm(f => ({ ...f, description: e.target.value }))} placeholder="Style description..." />
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button style={{ ...S.btnSecondary, flex: 1 }} onClick={onClose}>Cancel</button>
            <button
              style={{ ...S.btnPrimary, flex: 2, opacity: cannotCreate ? 0.5 : 1 }}
              disabled={cannotCreate}
              onClick={onCreate}
            >Create Tech Pack</button>
          </div>
        </div>
      </div>
    </div>
  );
}
