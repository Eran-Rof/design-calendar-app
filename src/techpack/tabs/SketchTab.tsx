// Sketch tab extracted from TechPack.tsx. Two columns: front + back
// sketch upload slots on the left, callout list + stitching detail
// box on the right. Each callout is auto-numbered (next available
// via nextCalloutNumber in ../bomOps.ts).

import type { TechPack, FlatSketch, SketchCallout } from "../types";
import {
  addSketchCallout,
  updateSketchCallout,
  removeSketchCallout,
  sortCalloutsByNumber,
} from "../bomOps";
import S from "../styles";

export interface SketchTabProps {
  tp: TechPack;
  updateSelected: (changes: Partial<TechPack>) => void;
  uploadImage: (file: File, path: string) => Promise<string | null>;
  setLightboxImg: (url: string | null) => void;
  showToast: (msg: string) => void;
}

export function SketchTab({ tp, updateSelected, uploadImage, setLightboxImg, showToast }: SketchTabProps) {
  const sk: FlatSketch = tp.flatSketch || { frontImage: null, backImage: null, callouts: [], stitchingDetails: "", measurementNote: "" };

  const updateSketch = (changes: Partial<FlatSketch>) =>
    updateSelected({ flatSketch: { ...sk, ...changes } });

  const addCallout = () => updateSketch({ callouts: addSketchCallout(sk.callouts) });
  const updateCallout = (id: string, changes: Partial<SketchCallout>) =>
    updateSketch({ callouts: updateSketchCallout(sk.callouts, id, changes) });
  const removeCallout = (id: string) =>
    updateSketch({ callouts: removeSketchCallout(sk.callouts, id) });

  const uploadSketchImage = async (file: File, side: "frontImage" | "backImage") => {
    const url = await uploadImage(file, `/techpacks/${tp.id}/sketch/${side}-${file.name}`);
    if (url) updateSketch({ [side]: url });
    else showToast("Upload failed");
  };

  const SketchImageSlot = ({ side, label }: { side: "frontImage" | "backImage"; label: string }) => {
    const img = sk[side];
    return (
      <div style={{ flex: 1 }}>
        <div style={{ color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, fontWeight: 600 }}>{label}</div>
        <label style={{ display: "block", cursor: "pointer" }}>
          <input type="file" accept="image/*" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) uploadSketchImage(f, side); }} />
          {img ? (
            <div style={{ position: "relative", border: "1px solid #334155", borderRadius: 10, overflow: "hidden", background: "#fff" }}>
              <img src={img} alt={label} style={{ width: "100%", maxHeight: 400, objectFit: "contain", display: "block" }} onClick={e => { e.preventDefault(); setLightboxImg(img); }} />
              <button
                style={{ position: "absolute", top: 8, right: 8, background: "#EF444488", border: "none", borderRadius: 6, color: "#fff", fontSize: 12, padding: "4px 8px", cursor: "pointer" }}
                onClick={e => { e.preventDefault(); updateSketch({ [side]: null }); }}
              >Remove</button>
            </div>
          ) : (
            <div
              style={{ border: "2px dashed #334155", borderRadius: 10, height: 280, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: "#4B5563", background: "#0F172A", transition: "border-color .15s" }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = "#3B82F6")}
              onMouseLeave={e => (e.currentTarget.style.borderColor = "#334155")}
            >
              <div style={{ fontSize: 13, fontWeight: 600, color: "#6B7280" }}>Upload {label}</div>
              <div style={{ fontSize: 11, color: "#4B5563" }}>Click to browse</div>
            </div>
          )}
        </label>
      </div>
    );
  };

  const sortedCallouts = sortCalloutsByNumber(sk.callouts);

  return (
    <>
      {/* Header row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h3 style={{ margin: 0, color: "#F1F5F9", fontSize: 16 }}>Style Design Detail</h3>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ color: "#94A3B8", fontSize: 12 }}>Measurements based on size</label>
            <input
              style={{ ...S.input, width: 70, padding: "5px 10px", fontSize: 13 }}
              value={sk.measurementNote}
              onChange={e => updateSketch({ measurementNote: e.target.value })}
              placeholder="32"
            />
          </div>
          <button style={S.btnSmall} onClick={addCallout}>+ Callout</button>
        </div>
      </div>

      {/* Two-column layout: sketches left, callouts right */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 20 }}>
        {/* Left: front + back sketch images */}
        <div style={{ display: "flex", gap: 12 }}>
          <SketchImageSlot side="frontImage" label="Front View" />
          <SketchImageSlot side="backImage" label="Back View" />
        </div>

        {/* Right: callout list + stitching details */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Callouts */}
          <div style={{ background: "#0F172A", borderRadius: 10, padding: 14, border: "1px solid #334155" }}>
            <div style={{ color: "#94A3B8", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, fontWeight: 600, marginBottom: 10 }}>Details</div>
            {sortedCallouts.length === 0 ? (
              <div style={{ color: "#4B5563", fontSize: 12, textAlign: "center", padding: "16px 0" }}>No callouts yet.<br />Click "+ Callout" to add.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {sortedCallouts.map(c => (
                  <div key={c.id} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                    <div style={{ width: 24, height: 24, borderRadius: "50%", background: "#3B82F6", color: "#fff", fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 2 }}>
                      {c.number}
                    </div>
                    <input
                      style={{ ...S.cellInput, flex: 1, border: "1px solid #334155", borderRadius: 6, padding: "5px 8px", fontSize: 12 }}
                      value={c.description}
                      onChange={e => updateCallout(c.id, { description: e.target.value })}
                      placeholder={`Detail ${c.number}...`}
                    />
                    <button
                      style={{ ...S.iconBtnTiny, marginTop: 4, flexShrink: 0 }}
                      onClick={() => removeCallout(c.id)}
                    >Delete</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Stitching Details */}
          <div style={{ background: "#0F172A", borderRadius: 10, padding: 14, border: "1px solid #334155", flex: 1 }}>
            <div style={{ color: "#94A3B8", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, fontWeight: 600, marginBottom: 10 }}>Stitching Detail</div>
            <textarea
              style={{ ...S.textarea, minHeight: 120, fontSize: 12, lineHeight: 1.6 }}
              value={sk.stitchingDetails}
              onChange={e => updateSketch({ stitchingDetails: e.target.value })}
              placeholder={"e.g.\n- CHAINSTITCH @ INSEAM\n- SPI 8 @ OUTSEAM\n- BARTACK @ POCKET CORNERS\n- FLAT FELLED @ CROTCH SEAM"}
            />
          </div>

          {/* Measurement note display */}
          {sk.measurementNote && (
            <div style={{ color: "#EF4444", fontSize: 11, fontWeight: 700, textAlign: "center", fontStyle: "italic" }}>
              *MEASUREMENTS BASED ON SIZE {sk.measurementNote}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
