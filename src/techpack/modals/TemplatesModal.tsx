// Spec sheet templates modal extracted from TechPack.tsx. Grid of
// both built-in (BUILTIN_TEMPLATES) and planner-uploaded templates.
// Per-card actions: Use Template (pre-fills the create modal),
// Download Excel (blank-rows template), Delete (planner-uploaded
// only — built-ins can't be deleted).
//
// The Use / Download / Upload handlers flow back through props so
// the parent stays in charge of state transitions + persistence.

import type { SpecTemplate } from "../types";
import S from "../styles";

export interface TemplatesModalProps {
  allTemplates: SpecTemplate[];
  onClose: () => void;
  onUse: (t: SpecTemplate) => void;
  onDownload: (t: SpecTemplate) => void;
  onUpload: (file: File) => Promise<void> | void;
  onDelete: (t: SpecTemplate) => void;
}

const pomCount = (t: SpecTemplate) => t.rows.filter(r => !r.isSection).length;
const sizeSummary = (t: SpecTemplate) =>
  t.sizes.length <= 6
    ? t.sizes.join(", ")
    : `${t.sizes[0]}–${t.sizes[t.sizes.length - 1]} (${t.sizes.length} sizes)`;

export function TemplatesModal({
  allTemplates,
  onClose,
  onUse,
  onDownload,
  onUpload,
  onDelete,
}: TemplatesModalProps) {
  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 450, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 20px", overflowY: "auto" }}
      onClick={onClose}
    >
      <div
        style={{ background: "#1E293B", borderRadius: 16, width: "100%", maxWidth: 900, border: "1px solid #334155", boxShadow: "0 24px 64px rgba(0,0,0,0.5)" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "20px 24px", borderBottom: "1px solid #334155" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <rect x="3" y="3" width="7" height="7" rx="1.5" stroke="#60A5FA" strokeWidth="2"/>
              <rect x="14" y="3" width="7" height="7" rx="1.5" stroke="#60A5FA" strokeWidth="2"/>
              <rect x="3" y="14" width="7" height="7" rx="1.5" stroke="#60A5FA" strokeWidth="2"/>
              <rect x="14" y="14" width="7" height="7" rx="1.5" stroke="#60A5FA" strokeWidth="2"/>
            </svg>
            <h2 style={{ margin: 0, color: "#F1F5F9", fontSize: 20, fontWeight: 700 }}>Spec Sheet Templates</h2>
            <span style={{ fontSize: 12, color: "#6B7280" }}>{allTemplates.length} template{allTemplates.length !== 1 ? "s" : ""}</span>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <label
              style={{ background: "#334155", border: "1px solid #475569", borderRadius: 6, padding: "7px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, color: "#F1F5F9", fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}
              onMouseEnter={e => e.currentTarget.style.background = "#475569"}
              onMouseLeave={e => e.currentTarget.style.background = "#334155"}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 4v12M8 12l4 4 4-4" stroke="#F1F5F9" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 20h16" stroke="#F1F5F9" strokeWidth="2" strokeLinecap="round"/></svg>
              Upload Template
              <input
                type="file"
                accept=".xlsx"
                style={{ display: "none" }}
                onChange={e => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ""; }}
              />
            </label>
            <button style={S.closeBtn} onClick={onClose}>✕</button>
          </div>
        </div>

        {/* Template Grid */}
        <div style={{ padding: 24, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16 }}>
          {allTemplates.map(t => (
            <div key={t.id} style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ color: "#F1F5F9", fontWeight: 700, fontSize: 15 }}>{t.name}</div>
                  {t.isBuiltin && (
                    <span style={{ fontSize: 10, background: "#3B82F622", color: "#60A5FA", border: "1px solid #3B82F644", borderRadius: 4, padding: "1px 6px", fontWeight: 600 }}>Built-in</span>
                  )}
                </div>
                {!t.isBuiltin && (
                  <button
                    style={{ background: "none", border: "none", cursor: "pointer", color: "#6B7280", fontSize: 14, padding: 2 }}
                    title="Delete template"
                    onMouseEnter={e => e.currentTarget.style.color = "#EF4444"}
                    onMouseLeave={e => e.currentTarget.style.color = "#6B7280"}
                    onClick={() => onDelete(t)}
                  >Delete</button>
                )}
              </div>
              <div style={{ color: "#94A3B8", fontSize: 12, lineHeight: 1.5 }}>{t.description}</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
                {t.category && (
                  <span style={{ fontSize: 11, background: "#1E293B", color: "#94A3B8", border: "1px solid #334155", borderRadius: 4, padding: "2px 8px" }}>{t.category}</span>
                )}
                <span style={{ fontSize: 11, background: "#1E293B", color: "#94A3B8", border: "1px solid #334155", borderRadius: 4, padding: "2px 8px" }}>{pomCount(t)} POMs</span>
                <span style={{ fontSize: 11, background: "#1E293B", color: "#94A3B8", border: "1px solid #334155", borderRadius: 4, padding: "2px 8px", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{sizeSummary(t)}</span>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button
                  style={{ flex: 1, background: "linear-gradient(135deg,#3B82F6,#2563EB)", border: "none", borderRadius: 6, padding: "7px 0", cursor: "pointer", color: "#fff", fontSize: 12, fontWeight: 700, fontFamily: "inherit" }}
                  onMouseEnter={e => e.currentTarget.style.opacity = "0.85"}
                  onMouseLeave={e => e.currentTarget.style.opacity = "1"}
                  onClick={() => onUse(t)}
                >Use Template</button>
                <button
                  title="Download blank Excel"
                  onClick={() => onDownload(t)}
                  style={{ background: "#1D6F42", border: "none", borderRadius: 6, padding: "7px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, color: "#fff", fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}
                  onMouseEnter={e => e.currentTarget.style.background = "#155734"}
                  onMouseLeave={e => e.currentTarget.style.background = "#1D6F42"}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" fill="#fff" fillOpacity=".2" stroke="#fff" strokeWidth="1.5"/><path d="M14 2v6h6" stroke="#fff" strokeWidth="1.5"/><path d="M8 13l2.5 4M8 17l2.5-4M13 13v4M15.5 13v4M13 15h2.5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
              </div>
            </div>
          ))}
          {allTemplates.length === 0 && (
            <div style={{ gridColumn: "1/-1", textAlign: "center", padding: 40, color: "#6B7280" }}>
              <p>No templates yet. Upload an Excel file to create one.</p>
            </div>
          )}
        </div>
        <div style={{ padding: "0 24px 24px", color: "#6B7280", fontSize: 12 }}>
          Click <strong style={{ color: "#60A5FA" }}>Use Template</strong> to create a new spec sheet pre-filled with the template's measurements. Click the Excel button to download a blank template.
        </div>
      </div>
    </div>
  );
}
