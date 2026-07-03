// Construction tab extracted from TechPack.tsx. List of construction
// details (area + detail + notes + reference photos). Each row is
// independently editable; ✕ removes the row, the dashed + tile
// uploads reference photos via the parent-supplied uploadImage.

import type { TechPack, ConstructionDetail } from "../types";
import { uid } from "../utils";
import S from "../styles";

export interface ConstructionTabProps {
  tp: TechPack;
  updateSelected: (changes: Partial<TechPack>) => void;
  uploadImage: (file: File, path: string) => Promise<string | null>;
  setLightboxImg: (url: string | null) => void;
}

export function ConstructionTab({ tp, updateSelected, uploadImage, setLightboxImg }: ConstructionTabProps) {
  const updateAt = (idx: number, changes: Partial<ConstructionDetail>) => {
    const updated = [...tp.construction];
    updated[idx] = { ...updated[idx], ...changes };
    updateSelected({ construction: updated });
  };

  const addDetail = () => {
    updateSelected({
      construction: [
        ...tp.construction,
        { id: uid(), area: "", detail: "", notes: "", refImages: [] },
      ],
    });
  };

  const removeDetail = (id: string) => {
    updateSelected({ construction: tp.construction.filter(x => x.id !== id) });
  };

  const removeRefImage = (idx: number, imgIdx: number) => {
    const c = tp.construction[idx];
    updateAt(idx, { refImages: c.refImages.filter((_, i) => i !== imgIdx) });
  };

  const uploadRefImages = async (idx: number, files: FileList | null) => {
    if (!files) return;
    const c = tp.construction[idx];
    const urls: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const url = await uploadImage(files[i], `/techpacks/${tp.id}/construction/${c.id}/${files[i].name}`);
      if (url) urls.push(url);
    }
    if (urls.length) {
      updateAt(idx, { refImages: [...(c.refImages || []), ...urls] });
    }
  };

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h3 style={{ margin: 0, color: "#F1F5F9", fontSize: 16 }}>Construction Details</h3>
        <button style={S.btnSmall} onClick={addDetail}>+ Add Detail</button>
      </div>

      {tp.construction.length === 0 ? (
        <div style={{ ...S.emptyState, padding: 30 }}><p style={{ color: "#6B7280" }}>No construction details yet.</p></div>
      ) : (
        tp.construction.map((c, idx) => (
          <div key={c.id} style={{ background: idx % 2 === 0 ? "#0F172A" : "#1A2332", borderRadius: 8, padding: 14, marginBottom: 10, border: "1px solid #334155" }}>
            <div style={{ display: "flex", gap: 12, marginBottom: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={S.label}>Area</label>
                <input
                  style={S.input}
                  value={c.area}
                  placeholder="e.g. Front Body, Collar, Sleeve"
                  onChange={e => updateAt(idx, { area: e.target.value })}
                />
              </div>
              <button
                style={{ ...S.iconBtn, alignSelf: "flex-end", color: "#EF4444" }}
                onClick={() => removeDetail(c.id)}
              >Delete</button>
            </div>
            <label style={S.label}>Detail</label>
            <textarea
              style={{ ...S.textarea, minHeight: 60, marginBottom: 8 }}
              value={c.detail}
              onChange={e => updateAt(idx, { detail: e.target.value })}
              placeholder="Construction detail..."
            />
            <label style={S.label}>Notes</label>
            <input
              style={S.input}
              value={c.notes}
              onChange={e => updateAt(idx, { notes: e.target.value })}
              placeholder="Additional notes..."
            />

            {/* Reference photos */}
            <label style={{ ...S.label, marginTop: 10 }}>Reference Photos</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as any, marginTop: 4 }}>
              {(c.refImages || []).map((img, imgIdx) => (
                <div key={imgIdx} style={{ position: "relative", width: 72, height: 72 }}>
                  <img
                    src={img}
                    alt=""
                    style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8, border: "1px solid #334155", cursor: "pointer" }}
                    onClick={() => setLightboxImg(img)}
                  />
                  <button
                    style={{ position: "absolute", top: -4, right: -4, width: 18, height: 18, borderRadius: "50%", background: "#EF4444", color: "#fff", border: "none", fontSize: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                    onClick={() => removeRefImage(idx, imgIdx)}
                  >✕</button>
                </div>
              ))}
              <label style={{ width: 72, height: 72, border: "2px dashed #334155", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#6B7280", fontSize: 22 }}>
                +
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: "none" }}
                  onChange={e => uploadRefImages(idx, e.target.files)}
                />
              </label>
            </div>
          </div>
        ))
      )}
    </>
  );
}
