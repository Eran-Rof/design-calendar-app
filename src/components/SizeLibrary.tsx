import React, { useState } from "react";
import { TH } from "../utils/theme";
import { appConfirm } from "../utils/theme";
import { S } from "../utils/styles";
import { DEFAULT_SIZES } from "../utils/constants";

// ─── SIZE LIBRARY ─────────────────────────────────────────────────────────────
function SizeLibrary({ sizes, setSizes, isAdmin = false, genders = [], genderSizes = {}, setGenderSizes = null }) {
  const [newSize, setNewSize] = useState("");
  const [selGender, setSelGender] = useState(genders[0] || "");
  if (!isAdmin) return (
    <div style={{ padding: "20px", textAlign: "center", color: TH.textMuted, fontSize: 13 }}>
      <div style={{ fontSize: 24, marginBottom: 8 }}>🔒</div>
      <div style={{ fontWeight: 600, color: TH.text, marginBottom: 4 }}>Admin Only</div>
      <div>Only admins can manage this section.</div>
    </div>
  );
  function addSize() {
    const s = newSize.trim().toUpperCase();
    if (!s || sizes.includes(s)) {
      setNewSize("");
      return;
    }
    setSizes((sz) => [...sz, s]);
    setNewSize("");
  }
  return (
    <div>
      <div style={{ fontSize: 13, color: TH.textMuted, marginBottom: 16 }}>
        Manage available sizes shown in SKU editor. Changes apply to new
        collections.
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 20,
          padding: "16px",
          background: TH.surfaceHi,
          borderRadius: 10,
          border: `1px solid ${TH.border}`,
        }}
      >
        {[...sizes]
          .sort((a, b) => {
            const na = parseFloat(a),
              nb = parseFloat(b);
            if (!isNaN(na) && !isNaN(nb)) return na - nb;
            if (!isNaN(na)) return 1;
            if (!isNaN(nb)) return -1;
            return 0;
          })
          .map((sz) => (
            <div
              key={sz}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "5px 10px",
                borderRadius: 20,
                border: `1px solid ${TH.border}`,
                background: TH.surface,
                fontSize: 13,
                fontWeight: 600,
                color: TH.text,
              }}
            >
              {sz}
              <button
                onClick={() => setSizes((s) => s.filter((x) => x !== sz))}
                style={{
                  background: "none",
                  border: "none",
                  color: "#B91C1C",
                  cursor: "pointer",
                  fontSize: 14,
                  lineHeight: 1,
                  padding: "0 0 0 4px",
                }}
              >
                ×
              </button>
            </div>
          ))}
        {sizes.length === 0 && (
          <span style={{ color: TH.textMuted, fontSize: 13 }}>
            No sizes. Add some below.
          </span>
        )}
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <input
          style={{ ...S.inp, marginBottom: 0, flex: 1 }}
          placeholder="e.g. 4XL or 40"
          value={newSize}
          onChange={(e) => setNewSize(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addSize()}
        />
        <button onClick={addSize} style={{ ...S.btn, whiteSpace: "nowrap" }}>
          + Add Size
        </button>
      </div>
      <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <span
          style={{ fontSize: 12, color: TH.textMuted, alignSelf: "center" }}
        >
          Quick add:
        </span>
        {[
          ["Numeric Denim", "28,29,30,31,32,33,34,36,38"],
          ["Alpha Basics", "XS,S,M,L,XL,XXL"],
          ["Extended", "XS,S,M,L,XL,XXL,2XL,3XL,4XL"],
          ["Kids", "4,6,8,10,12,14,16"],
        ].map(([label, vals]) => (
          <button
            key={label}
            onClick={() => {
              const toAdd = vals
                .split(",")
                .filter((v) => !sizes.includes(v.trim()));
              setSizes((s) => [...s, ...toAdd]);
            }}
            style={{
              padding: "4px 12px",
              borderRadius: 16,
              border: `1px solid ${TH.primary}`,
              background: TH.primary + "10",
              color: TH.primary,
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        style={{
          marginTop: 16,
          padding: "10px 14px",
          background: "#FFFBEB",
          border: "1px solid #FCD34D",
          borderRadius: 8,
          fontSize: 12,
          color: "#92400E",
        }}
      >
        💡 To reset to defaults:{" "}
        <button
          onClick={() => setSizes(DEFAULT_SIZES)}
          style={{
            background: "none",
            border: "none",
            color: TH.primary,
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: 12,
            textDecoration: "underline",
            padding: 0,
          }}
        >
          Restore defaults
        </button>
      </div>
      {/* ── Gender size assignment ── */}
      {genders.length > 0 && setGenderSizes && (
        <div style={{ marginTop: 24, borderTop: `1px solid ${TH.border}`, paddingTop: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: TH.text, marginBottom: 10 }}>Assign Sizes by Gender</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
            <span style={{ fontSize: 12, color: TH.textMuted, whiteSpace: "nowrap" }}>Gender:</span>
            <select value={selGender} onChange={e => setSelGender(e.target.value)}
              style={{ ...S.inp, marginBottom: 0, flex: 1 }}>
              {genders.map((g: string) => <option key={g}>{typeof g === "string" ? g : (g as any).label}</option>)}
            </select>
          </div>
          {selGender && (
            <div>
              <div style={{ fontSize: 12, color: TH.textMuted, marginBottom: 8 }}>Click sizes to toggle for <strong>{selGender}</strong>:</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {[...sizes].sort((a, b) => {
                  const na = parseFloat(a), nb = parseFloat(b);
                  if (!isNaN(na) && !isNaN(nb)) return na - nb;
                  return 0;
                }).map((sz: string) => {
                  const sel = (genderSizes[selGender] || []).includes(sz);
                  return (
                    <button key={sz} onClick={() => setGenderSizes((gs: any) => {
                      const cur = gs[selGender] || [];
                      return { ...gs, [selGender]: sel ? cur.filter((x: string) => x !== sz) : [...cur, sz] };
                    })}
                      style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${sel ? TH.primary : TH.border}`, background: sel ? TH.primary : "none", color: sel ? "#fff" : TH.textSub, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600 }}>
                      {sz}
                    </button>
                  );
                })}
              </div>
              {(genderSizes[selGender] || []).length > 0 && (
                <div style={{ marginTop: 8, fontSize: 11, color: TH.textMuted }}>
                  Selected: {(genderSizes[selGender] || []).join(", ")}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}


export default SizeLibrary;
