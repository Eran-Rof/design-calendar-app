import React, { useState } from "react";
import { TH } from "../utils/theme";
import { S } from "../utils/styles";
import { uid } from "../utils/dates";
import { DEFAULT_SIZES } from "../utils/constants";
import { autoGenSkus } from "../utils/helpers";
import ImageUploader from "./ImageUploader";
import { buildSkuCadPage } from "./NoteInput";

function SkuManager({ skus = [], onChange, brand, category, availableSizes }) {
  const rawSizes =
    availableSizes && availableSizes.length > 0
      ? availableSizes
      : DEFAULT_SIZES;
  const SIZES = [...rawSizes].sort((a, b) => {
    const na = parseFloat(a),
      nb = parseFloat(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    if (!isNaN(na)) return 1;
    if (!isNaN(nb)) return -1;
    return 0;
  });
  const [editing, setEditing] = useState(null);

  const [selectedSkus, setSelectedSkus] = useState(new Set());
  const [showPrice, setShowPrice] = useState(false);
  const [form, setForm] = useState(null);
  const [autoCount, setAutoCount] = useState(3);
  const [showAuto, setShowAuto] = useState(false);
  const [localSizes, setLocalSizes] = useState(null); // null = use SIZES prop
  const [newSizeInput, setNewSizeInput] = useState("");
  const [userTypedTargets, setUserTypedTargets] = useState([]); // tracks which target fields user manually typed
  const effectiveSizes = localSizes || SIZES;
  function addCustomSize() {
    const s = newSizeInput.trim().toUpperCase();
    if (!s) return;
    const next = [...effectiveSizes];
    if (!next.includes(s)) {
      next.push(s);
      next.sort((a, b) => {
        const na = parseFloat(a),
          nb = parseFloat(b);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        if (!isNaN(na)) return 1;
        if (!isNaN(nb)) return -1;
        return 0;
      });
    }
    setLocalSizes(next);
    setNewSizeInput("");
  }
  const BLANK = () => ({
    id: uid(),
    styleNum: "",
    description: "",
    colorways: "",
    fabric: "",
    sizes: [],
    units: 0,
    fob: "",
    landed: "",
    wholesale: "",
    retail: "",
    marginPct: "",
    targetDDP: "",
    targetSelling: "",
    targetMargin: "",
    images: [],
  });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleSize = (sz) =>
    setForm((f) => ({
      ...f,
      sizes: f.sizes.includes(sz)
        ? f.sizes.filter((s) => s !== sz)
        : [...f.sizes, sz],
    }));

  // Dynamic target costing: use userTypedTargets to know which fields are user-entered anchors
  function handleTargetField(field, val) {
    // Mark this field as user-typed
    setUserTypedTargets((prev) =>
      prev.includes(field) ? prev : [...prev, field]
    );
    setForm((f) => {
      const next = { ...f, [field]: val };
      const typedArr = userTypedTargets.includes(field)
        ? userTypedTargets
        : [...userTypedTargets, field];
      const ddp = parseFloat(field === "targetDDP" ? val : next.targetDDP);
      const sell = parseFloat(
        field === "targetSelling" ? val : next.targetSelling
      );
      const mgn = parseFloat(
        field === "targetMargin" ? val : next.targetMargin
      );
      const validDDP = typedArr.includes("targetDDP") && !isNaN(ddp) && ddp > 0;
      const validSell =
        typedArr.includes("targetSelling") && !isNaN(sell) && sell > 0;
      const validMgn =
        typedArr.includes("targetMargin") &&
        !isNaN(mgn) &&
        mgn > 0 &&
        mgn < 100;
      // Derive exactly the one field the user has NOT typed yet
      if (field === "targetDDP") {
        if (validMgn && !typedArr.includes("targetSelling"))
          next.targetSelling = (ddp / (1 - mgn / 100)).toFixed(2);
        else if (validSell && !typedArr.includes("targetMargin"))
          next.targetMargin = (((sell - ddp) / sell) * 100).toFixed(2);
      } else if (field === "targetSelling") {
        if (validDDP && !typedArr.includes("targetMargin"))
          next.targetMargin = (((sell - ddp) / sell) * 100).toFixed(2);
        else if (validMgn && !typedArr.includes("targetDDP"))
          next.targetDDP = (sell * (1 - mgn / 100)).toFixed(2);
      } else if (field === "targetMargin") {
        if (validDDP && !typedArr.includes("targetSelling"))
          next.targetSelling = (ddp / (1 - mgn / 100)).toFixed(2);
        else if (validSell && !typedArr.includes("targetDDP"))
          next.targetDDP = (sell * (1 - mgn / 100)).toFixed(2);
      }
      return next;
    });
  }
  function clearTargets() {
    setForm((f) => ({
      ...f,
      targetDDP: "",
      targetSelling: "",
      targetMargin: "",
    }));
    setUserTypedTargets([]);
  }

  function save() {
    if (editing === "new") onChange([...skus, form]);
    else onChange(skus.map((s) => (s.id === editing ? form : s)));
    setEditing(null);
    setForm(null);
    setUserTypedTargets([]);
  }
  function handleAutoGen() {
    const newSkus = autoGenSkus(brand, category, autoCount);
    const merged = [...skus, ...newSkus];
    onChange(merged);
    setShowAuto(false);
  }

  if (editing)
    return (
      <div>
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}
        >
          <div>
            <label style={S.lbl}>Style Number</label>
            <input
              style={{ ...S.inp, marginBottom: 0 }}
              value={form.styleNum}
              onChange={(e) => set("styleNum", e.target.value)}
              placeholder="ROF-DN-1042"
            />
          </div>
          <div>
            <label style={S.lbl}>Units</label>
            <input
              type="number"
              style={{ ...S.inp, marginBottom: 0 }}
              value={form.units}
              onChange={(e) => set("units", parseInt(e.target.value) || 0)}
            />
          </div>
        </div>
        <div style={{ height: 14 }} />
        <label style={S.lbl}>Style Description</label>
        <input
          style={S.inp}
          value={form.description}
          onChange={(e) => set("description", e.target.value)}
          placeholder="5-pocket slim fit denim"
        />
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}
        >
          <div>
            <label style={S.lbl}>Colorways</label>
            <input
              style={{ ...S.inp, marginBottom: 0 }}
              value={form.colorways}
              onChange={(e) => set("colorways", e.target.value)}
            />
          </div>
          <div>
            <label style={S.lbl}>Fabric/Material</label>
            <input
              style={{ ...S.inp, marginBottom: 0 }}
              value={form.fabric}
              onChange={(e) => set("fabric", e.target.value)}
            />
          </div>
        </div>
        <div style={{ height: 14 }} />
        <label style={S.lbl}>Sizes</label>
        <div
          style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}
        >
          {effectiveSizes.map((sz) => (
            <button
              key={sz}
              onClick={() => toggleSize(sz)}
              style={{
                padding: "4px 11px",
                borderRadius: 16,
                border: `1px solid ${
                  form.sizes.includes(sz) ? TH.primary : TH.border
                }`,
                background: form.sizes.includes(sz)
                  ? TH.primary + "15"
                  : "transparent",
                color: form.sizes.includes(sz) ? TH.primary : TH.textMuted,
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 12,
              }}
            >
              {sz}
            </button>
          ))}
        </div>
        <div
          style={{
            display: "flex",
            gap: 6,
            marginBottom: 14,
            alignItems: "center",
          }}
        >
          <input
            value={newSizeInput}
            onChange={(e) => setNewSizeInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addCustomSize()}
            placeholder="Add size (e.g. 40)"
            style={{
              ...S.inp,
              marginBottom: 0,
              flex: 1,
              fontSize: 12,
              padding: "5px 10px",
            }}
          />
          <button
            onClick={addCustomSize}
            style={{
              padding: "5px 12px",
              borderRadius: 8,
              border: `1px solid ${TH.primary}`,
              background: TH.primary + "12",
              color: TH.primary,
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 12,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            + Add Size
          </button>
        </div>
        <span style={S.sec}>Costing</span>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3,1fr)",
            gap: 12,
          }}
        >
          {[
            ["FOB Cost", "fob", "$"],
            ["Landed Cost", "landed", "$"],
            ["Wholesale", "wholesale", "$"],
            ["Retail", "retail", "$"],
            ["Margin %", "marginPct", "%"],
          ].map(([lbl, key, sym]) => (
            <div key={key}>
              <label style={S.lbl}>{lbl}</label>
              <div style={{ position: "relative" }}>
                <span
                  style={{
                    position: "absolute",
                    left: 10,
                    top: "50%",
                    transform: "translateY(-50%)",
                    color: TH.textMuted,
                    fontSize: 13,
                  }}
                >
                  {sym}
                </span>
                <input
                  style={{ ...S.inp, marginBottom: 0, paddingLeft: 22 }}
                  value={form[key]}
                  onChange={(e) => set(key, e.target.value)}
                  placeholder="0.00"
                />
              </div>
            </div>
          ))}
        </div>
        <div style={{ height: 14 }} />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 6,
          }}
        >
          <span style={S.sec}>
            Target Costing{" "}
            <span
              style={{
                fontWeight: 400,
                fontSize: 11,
                color: TH.textMuted,
                textTransform: "none",
              }}
            >
              {" "}
              — enter any 2, third auto-calculates
            </span>
          </span>
          <button
            onClick={clearTargets}
            style={{
              padding: "3px 10px",
              borderRadius: 6,
              border: `1px solid ${TH.border}`,
              background: "none",
              color: TH.textMuted,
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 11,
            }}
          >
            Clear All
          </button>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 12,
            background: TH.primary + "06",
            border: `1px solid ${TH.primary}22`,
            borderRadius: 10,
            padding: "14px",
          }}
        >
          {[
            ["Target DDP Cost", "targetDDP", "$"],
            ["Target Selling Price", "targetSelling", "$"],
            ["Target Margin %", "targetMargin", "%"],
          ].map(([lbl, key, sym]) => (
            <div key={key}>
              <label style={{ ...S.lbl, color: TH.primary }}>{lbl}</label>
              <div style={{ position: "relative" }}>
                <span
                  style={{
                    position: "absolute",
                    left: 10,
                    top: "50%",
                    transform: "translateY(-50%)",
                    color: TH.primary,
                    fontSize: 13,
                    opacity: 0.7,
                  }}
                >
                  {sym}
                </span>
                <input
                  style={{
                    ...S.inp,
                    marginBottom: 0,
                    paddingLeft: 22,
                    borderColor: TH.primary + "44",
                    background: TH.primary + "05",
                  }}
                  value={form[key] || ""}
                  onChange={(e) => handleTargetField(key, e.target.value)}
                  placeholder="0.00"
                />
              </div>
            </div>
          ))}
        </div>
        <div style={{ height: 14 }} />
        <ImageUploader
          images={form.images || []}
          onChange={(v) => set("images", v)}
          label="Attachments"
        />
        <div
          style={{
            display: "flex",
            gap: 10,
            justifyContent: "flex-end",
            marginTop: 8,
          }}
        >
          <button
            onClick={() => {
              setEditing(null);
              setForm(null);
            }}
            style={{
              padding: "9px 18px",
              borderRadius: 8,
              border: `1px solid ${TH.border}`,
              background: "none",
              color: TH.textMuted,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Cancel
          </button>
          <button onClick={save} style={S.btn}>
            Save SKU
          </button>
        </div>
      </div>
    );

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 14,
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <span style={S.sec}>SKUs ({skus.length})</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setShowAuto(!showAuto)}
            style={{
              padding: "6px 14px",
              borderRadius: 8,
              border: `1px solid ${TH.primary}`,
              background: TH.primary + "10",
              color: TH.primary,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 12,
            }}
          >
            ⚡ Auto-Generate
          </button>
          <button
            onClick={() => {
              setForm(BLANK());
              setEditing("new");
            }}
            style={{ ...S.btn, padding: "6px 14px", fontSize: 12 }}
          >
            + Add SKU
          </button>
        </div>
      </div>

      {showAuto && (
        <div
          style={{
            ...S.card,
            marginBottom: 16,
            background: TH.primary + "08",
            border: `1px solid ${TH.primary}33`,
          }}
        >
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: TH.text,
              marginBottom: 8,
            }}
          >
            ⚡ Auto-Generate SKUs
          </div>
          <div style={{ fontSize: 12, color: TH.textMuted, marginBottom: 12 }}>
            System will generate style numbers, descriptions, colorways, and
            fabrics based on <strong>{category}</strong> category.
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label style={{ ...S.lbl, marginBottom: 0 }}>
                Number of SKUs:
              </label>
              <input
                type="number"
                min="1"
                max="20"
                value={autoCount}
                onChange={(e) =>
                  setAutoCount(
                    Math.min(20, Math.max(1, parseInt(e.target.value) || 1))
                  )
                }
                style={{
                  ...S.inp,
                  marginBottom: 0,
                  width: 70,
                  textAlign: "center",
                }}
              />
            </div>
            <button
              onClick={() => {
                handleAutoGen();
              }}
              style={S.btn}
            >
              Generate & Save {autoCount} SKU{autoCount !== 1 ? "s" : ""}
            </button>
            <button
              onClick={() => setShowAuto(false)}
              style={{
                padding: "9px 14px",
                borderRadius: 8,
                border: `1px solid ${TH.border}`,
                background: "none",
                color: TH.textMuted,
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 13,
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {skus.length === 0 && (
        <div
          style={{
            textAlign: "center",
            color: TH.textMuted,
            padding: "24px",
            fontSize: 13,
            border: `1px dashed ${TH.border}`,
            borderRadius: 10,
          }}
        >
          No SKUs yet. Add manually or use Auto-Generate.
        </div>
      )}
      {/* SKU selection toolbar */}
      {skus.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
          {selectedSkus.size === 0 ? (
            <span style={{ fontSize: 12, color: TH.textMuted }}>Click checkboxes to select SKUs for a CAD page</span>
          ) : (
            <>
              <span style={{ fontSize: 12, color: TH.textMuted }}>{selectedSkus.size} SKU{selectedSkus.size > 1 ? "s" : ""} selected</span>
              <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: TH.text, cursor: "pointer" }}>
                <input type="checkbox" checked={showPrice} onChange={e => setShowPrice(e.target.checked)} />
                Show Selling Price
              </label>
              <button
                onClick={() => {
                  const sel = skus.filter(s => selectedSkus.has(s.id));
                  const url = buildSkuCadPage(sel, brand, showPrice, "link");
                  navigator.clipboard.writeText(url).then(() => alert("CAD link copied!")).catch(() => prompt("Copy link:", url));
                }}
                style={{ padding: "4px 12px", borderRadius: 7, border: `1px solid ${TH.border}`, background: TH.surfaceHi, color: TH.text, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600 }}
              >🔗 Copy Link</button>
              <button
                onClick={() => {
                  const sel = skus.filter(s => selectedSkus.has(s.id));
                  const url = buildSkuCadPage(sel, brand, showPrice, "open");
                  window.open(url, "_blank");
                }}
                style={{ padding: "4px 12px", borderRadius: 7, border: `1px solid ${TH.border}`, background: TH.surfaceHi, color: TH.text, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600 }}
              >🖨️ Open CAD Page</button>
              <button
                onClick={() => { setSelectedSkus(new Set()); setShowPrice(false); }}
                style={{ padding: "4px 10px", borderRadius: 7, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}
              >✕ Clear</button>
            </>
          )}
        </div>
      )}
      <div style={{ display: "grid", gap: 8 }}>
        {skus.map((s) => {
          const isSelected = selectedSkus.has(s.id);
          return (
          <div
            key={s.id}
            style={{
              ...S.card,
              display: "flex",
              gap: 14,
              alignItems: "flex-start",
              border: isSelected ? `2px solid ${TH.primary}` : S.card.border,
              background: isSelected ? TH.primary + "08" : S.card.background,
            }}
          >
            {/* Checkbox */}
            <div
              onClick={() => setSelectedSkus(prev => {
                const next = new Set(prev);
                if (next.has(s.id)) next.delete(s.id); else next.add(s.id);
                return next;
              })}
              style={{ width: 18, height: 18, borderRadius: 4, border: `2px solid ${isSelected ? TH.primary : TH.border}`, background: isSelected ? TH.primary : "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0, marginTop: 4 }}
            >
              {isSelected && <span style={{ color: "#fff", fontSize: 11, fontWeight: 700 }}>✓</span>}
            </div>
            {s.images?.[0] ? (
              <img
                src={s.images[0].src}
                alt={s.styleNum}
                style={{
                  width: 64,
                  height: 64,
                  objectFit: "cover",
                  borderRadius: 8,
                  flexShrink: 0,
                }}
              />
            ) : (
              <div
                style={{
                  width: 64,
                  height: 64,
                  background: TH.surfaceHi,
                  border: `1px solid ${TH.border}`,
                  borderRadius: 8,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: TH.textMuted,
                  fontSize: 22,
                  flexShrink: 0,
                }}
              >
                👕
              </div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: 4,
                }}
              >
                <div>
                  <span
                    style={{ fontSize: 13, fontWeight: 700, color: TH.text }}
                  >
                    {s.styleNum || "No Style #"}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      color: TH.textMuted,
                      marginLeft: 10,
                    }}
                  >
                    {s.description}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => {
                      setForm({ ...s });
                      setEditing(s.id);
                      setUserTypedTargets(
                        Object.entries({
                          targetDDP: s.targetDDP,
                          targetSelling: s.targetSelling,
                          targetMargin: s.targetMargin,
                        })
                          .filter(([, v]) => v)
                          .map(([k]) => k)
                      );
                    }}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      border: `1px solid ${TH.border}`,
                      background: "none",
                      color: TH.textMuted,
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontSize: 11,
                    }}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => onChange(skus.filter((x) => x.id !== s.id))}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      border: "1px solid #FCA5A5",
                      background: "none",
                      color: "#B91C1C",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontSize: 11,
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                {s.colorways && (
                  <span style={{ fontSize: 11, color: TH.textMuted }}>
                    🎨 {s.colorways}
                  </span>
                )}
                {s.fabric && (
                  <span style={{ fontSize: 11, color: TH.textMuted }}>
                    🧵 {s.fabric}
                  </span>
                )}
                {s.sizes?.length > 0 && (
                  <span style={{ fontSize: 11, color: TH.textMuted }}>
                    📐 {s.sizes.join(", ")}
                  </span>
                )}
                {s.units > 0 && (
                  <span style={{ fontSize: 11, color: TH.textMuted }}>
                    📦 {s.units.toLocaleString()}
                  </span>
                )}
              </div>
              {(s.fob ||
                s.wholesale ||
                s.retail ||
                s.targetDDP ||
                s.targetSelling ||
                s.targetMargin) && (
                <div
                  style={{
                    display: "flex",
                    gap: 12,
                    marginTop: 5,
                    flexWrap: "wrap",
                  }}
                >
                  {s.fob && (
                    <span
                      style={{
                        fontSize: 11,
                        color: TH.primary,
                        fontWeight: 600,
                      }}
                    >
                      FOB ${s.fob}
                    </span>
                  )}
                  {s.wholesale && (
                    <span
                      style={{
                        fontSize: 11,
                        color: "#B45309",
                        fontWeight: 600,
                      }}
                    >
                      WHL ${s.wholesale}
                    </span>
                  )}
                  {s.retail && (
                    <span
                      style={{
                        fontSize: 11,
                        color: "#065F46",
                        fontWeight: 600,
                      }}
                    >
                      RTL ${s.retail}
                    </span>
                  )}
                  {s.marginPct && (
                    <span
                      style={{
                        fontSize: 11,
                        color: "#6D28D9",
                        fontWeight: 600,
                      }}
                    >
                      MGN {s.marginPct}%
                    </span>
                  )}
                  {s.targetDDP && (
                    <span
                      style={{
                        fontSize: 11,
                        color: TH.primary,
                        fontWeight: 600,
                        opacity: 0.75,
                      }}
                    >
                      T-DDP ${s.targetDDP}
                    </span>
                  )}
                  {s.targetSelling && (
                    <span
                      style={{
                        fontSize: 11,
                        color: "#065F46",
                        fontWeight: 600,
                        opacity: 0.75,
                      }}
                    >
                      T-SELL ${s.targetSelling}
                    </span>
                  )}
                  {s.targetMargin && (
                    <span
                      style={{
                        fontSize: 11,
                        color: "#6D28D9",
                        fontWeight: 600,
                        opacity: 0.75,
                      }}
                    >
                      T-MGN {s.targetMargin}%
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        ); })}
      </div>
    </div>
  );
}

export default SkuManager;
