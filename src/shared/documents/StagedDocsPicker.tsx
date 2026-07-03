// src/shared/documents/StagedDocsPicker.tsx
//
// Lets a CREATE form collect document files before the row exists. The parent
// holds the File[] and, after the row is created (id known), uploads them with
// uploadStagedDocs(). Mirrors the DocumentAttachmentList look so the staged and
// saved states feel continuous.

import type { CSSProperties } from "react";

const C = {
  card: "#1E293B", cardBdr: "#334155",
  textMuted: "#94A3B8", textSub: "#CBD5E1", danger: "#EF4444",
};
const btnSecondary: CSSProperties = {
  background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "4px 10px", borderRadius: 4, cursor: "pointer", fontSize: 11, display: "inline-block",
};

export default function StagedDocsPicker({
  files, onChange, hint,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  hint?: string;
}) {
  return (
    <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: files.length ? 8 : 0 }}>
        <span style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
          Supporting documents {files.length > 0 && <span>({files.length})</span>}
        </span>
        <label style={{ ...btnSecondary, cursor: "pointer" }}>
          + Add files
          <input
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              const picked = Array.from(e.target.files || []);
              if (picked.length) onChange([...files, ...picked]);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      {files.map((f, i) => (
        <div key={`${f.name}-${i}`} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: C.textSub, paddingTop: 4 }}>
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
          <button
            type="button"
            onClick={() => onChange(files.filter((_, j) => j !== i))}
            style={{ background: "transparent", color: C.danger, border: "none", cursor: "pointer", fontSize: 12 }}
          >
            Remove
          </button>
        </div>
      ))}
      {files.length === 0 && (
        <span style={{ fontSize: 11, color: C.textMuted }}> — {hint || "uploaded when you save."}</span>
      )}
    </div>
  );
}
