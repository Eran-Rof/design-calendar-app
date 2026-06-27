// Images tab extracted from TechPack.tsx. A simple image grid with a
// drag-up-to-upload affordance + per-image lightbox click and ✕ delete.
//
// The actual upload happens via a parent-supplied uploadImage callback
// (currently routes through the Dropbox proxy in TechPack.tsx), so this
// component stays unaware of where the bytes go.

import type { TechPack, TPImage } from "../types";
import { uid } from "../utils";
import S from "../styles";

export interface ImagesTabProps {
  tp: TechPack;
  updateSelected: (changes: Partial<TechPack>) => void;
  uploadImage: (file: File, path: string) => Promise<string | null>;
  setLightboxImg: (url: string | null) => void;
}

export function ImagesTab({ tp, updateSelected, uploadImage, setLightboxImg }: ImagesTabProps) {
  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    // Accumulate images locally so a multi-file selection only triggers
    // one updateSelected at the end (avoids partial re-render thrash).
    let next = tp.images;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const url = await uploadImage(file, `/techpacks/${tp.id}/images/${file.name}`);
      if (url) {
        const img: TPImage = { id: uid(), url, name: file.name, type: file.type };
        next = [...next, img];
        updateSelected({ images: next });
      }
    }
  };

  const removeImage = (imgId: string) => {
    updateSelected({ images: tp.images.filter(x => x.id !== imgId) });
  };

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h3 style={{ margin: 0, color: "#F1F5F9", fontSize: 16 }}>Product Images</h3>
        <label style={S.btnSmall}>
          + Upload Image
          <input type="file" accept="image/*" multiple style={{ display: "none" }} onChange={e => onFiles(e.target.files)} />
        </label>
      </div>

      {tp.images.length === 0 ? (
        <div style={{ ...S.emptyState, padding: 40 }}>
          <p style={{ color: "#6B7280" }}>No images uploaded yet</p>
          <label style={S.btnPrimarySmall}>
            Upload Images
            <input type="file" accept="image/*" multiple style={{ display: "none" }} onChange={e => onFiles(e.target.files)} />
          </label>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12 }}>
          {tp.images.map(img => (
            <div key={img.id} style={{ position: "relative", borderRadius: 8, overflow: "hidden", border: "1px solid #334155", cursor: "pointer" }}>
              <img
                src={img.url}
                alt={img.name}
                style={{ width: "100%", height: 150, objectFit: "cover" }}
                onClick={() => setLightboxImg(img.url)}
              />
              <div style={{ padding: "6px 8px", background: "#0F172A", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ color: "#94A3B8", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{img.name}</span>
                <button
                  style={{ ...S.iconBtnTiny, flexShrink: 0 }}
                  onClick={() => removeImage(img.id)}
                >Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
