// Samples tab extracted from TechPack.tsx. Adds + edits + removes
// samples on a tech pack. The auto-receiveDate transition (stamp
// today when status flips to Received / Approved / Rejected) lives
// in ../sampleOps.ts (pinned by 11 unit tests).

import type { TechPack, Sample } from "../types";
import { today as todayFn } from "../utils";
import { createEmptySample, updateSampleStatus } from "../sampleOps";
import { SAMPLE_TYPES, SAMPLE_STATUS_COLORS } from "../constants";
import SearchableSelect from "../../tanda/components/SearchableSelect";
import S from "../styles";

const SAMPLE_STATUSES: Sample["status"][] = ["Requested", "In Progress", "Received", "Approved", "Rejected"];

export interface SamplesTabProps {
  tp: TechPack;
  updateSelected: (changes: Partial<TechPack>) => void;
  uploadImage: (file: File, path: string) => Promise<string | null>;
  setLightboxImg: (url: string | null) => void;
  showToast: (msg: string) => void;
  /** Injected so tests can pin a deterministic date. */
  today?: () => string;
}

export function SamplesTab({
  tp,
  updateSelected,
  uploadImage,
  setLightboxImg,
  showToast,
  today = todayFn,
}: SamplesTabProps) {
  const updateAt = (idx: number, changes: Partial<Sample>) => {
    const updated = [...tp.samples];
    updated[idx] = { ...updated[idx], ...changes };
    updateSelected({ samples: updated });
  };

  const addSample = () => {
    updateSelected({ samples: [...tp.samples, createEmptySample(today)] });
  };

  const removeSample = (id: string) => {
    updateSelected({ samples: tp.samples.filter(x => x.id !== id) });
  };

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h3 style={{ margin: 0, color: "#F1F5F9", fontSize: 16 }}>Sample Tracking</h3>
        <button style={S.btnSmall} onClick={addSample}>+ Add Sample</button>
      </div>

      {tp.samples.length === 0 ? (
        <div style={{ ...S.emptyState, padding: 30 }}><p style={{ color: "#6B7280" }}>No samples tracked yet.</p></div>
      ) : (
        tp.samples.map((s, idx) => (
          <div key={s.id} style={{ background: "#0F172A", borderRadius: 10, padding: 16, marginBottom: 12, border: `1px solid ${SAMPLE_STATUS_COLORS[s.status]}44` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <SearchableSelect
                  value={s.type}
                  onChange={v => updateAt(idx, { type: v as Sample["type"] })}
                  options={SAMPLE_TYPES.map(t => ({ value: t, label: t }))}
                  inputStyle={S.select}
                />
                <span style={{
                  ...S.badge,
                  background: (SAMPLE_STATUS_COLORS[s.status] || "#6B7280") + "22",
                  color: SAMPLE_STATUS_COLORS[s.status] || "#6B7280",
                  border: `1px solid ${SAMPLE_STATUS_COLORS[s.status] || "#6B7280"}44`,
                }}>{s.status}</span>
              </div>
              <button
                style={{ ...S.iconBtn, color: "#EF4444" }}
                onClick={() => removeSample(s.id)}
              >Delete</button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={S.label}>Status</label>
                <SearchableSelect
                  value={s.status}
                  onChange={v => {
                    // Goes through updateSampleStatus so the
                    // auto-receiveDate rule fires uniformly.
                    const updated = [...tp.samples];
                    updated[idx] = updateSampleStatus(s, v as Sample["status"], today);
                    updateSelected({ samples: updated });
                  }}
                  options={SAMPLE_STATUSES.map(st => ({ value: st, label: st }))}
                  inputStyle={{ ...S.select, width: "100%" }}
                />
              </div>
              <div>
                <label style={S.label}>Vendor</label>
                <input
                  style={S.input}
                  value={s.vendor}
                  onChange={e => updateAt(idx, { vendor: e.target.value })}
                  placeholder="Vendor name"
                />
              </div>
              <div>
                <label style={S.label}>Request Date</label>
                <input
                  style={S.input}
                  type="date"
                  value={s.requestDate}
                  onChange={e => updateAt(idx, { requestDate: e.target.value })}
                />
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={S.label}>Receive Date</label>
                <input
                  style={S.input}
                  type="date"
                  value={s.receiveDate || ""}
                  onChange={e => updateAt(idx, { receiveDate: e.target.value || null })}
                />
              </div>
              <div>
                <label style={S.label}>Comments</label>
                <input
                  style={S.input}
                  value={s.comments}
                  onChange={e => updateAt(idx, { comments: e.target.value })}
                  placeholder="Comments..."
                />
              </div>
            </div>

            {/* Sample Images */}
            <div>
              <label style={S.label}>Images</label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {s.images.map((img, imgIdx) => (
                  <div key={imgIdx} style={{ position: "relative", width: 60, height: 60 }}>
                    <img
                      src={img}
                      alt=""
                      style={{ width: 60, height: 60, borderRadius: 6, objectFit: "cover", cursor: "pointer" }}
                      onClick={() => setLightboxImg(img)}
                    />
                    <button
                      style={{ position: "absolute", top: -4, right: -4, width: 18, height: 18, borderRadius: "50%", background: "#EF4444", color: "#fff", border: "none", fontSize: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                      onClick={() => updateAt(idx, { images: s.images.filter((_, i) => i !== imgIdx) })}
                    >✕</button>
                  </div>
                ))}
                <label style={{ width: 60, height: 60, borderRadius: 6, border: "2px dashed #334155", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#6B7280", fontSize: 20 }}>
                  +
                  <input
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    onChange={async e => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const url = await uploadImage(file, `/techpacks/${tp.id}/samples/${s.id}/${file.name}`);
                      if (url) {
                        updateAt(idx, { images: [...s.images, url] });
                      } else {
                        showToast("Image upload failed");
                      }
                    }}
                  />
                </label>
              </div>
            </div>
          </div>
        ))
      )}
    </>
  );
}
