import React, { useState } from "react";
import { TH } from "../utils/theme";
import { appConfirm } from "../utils/theme";
import { S } from "../utils/styles";
import { uid } from "../utils/dates";

function BrandManager({ brands, setBrands, isAdmin = false }: {
  brands: any[];
  setBrands: (fn: any) => void;
  isAdmin?: boolean;
}) {
  const BLANK = () => ({
    id: uid(),
    name: "",
    short: "",
    color: "#3498DB",
    isPrivateLabel: false,
  });
  const [editing, setEditing] = useState<any>(null);
  if (!isAdmin) return (
    <div style={{ padding: "20px", textAlign: "center", color: TH.textMuted, fontSize: 13 }}>
      <div style={{ fontSize: 24, marginBottom: 8 }}>🔒</div>
      <div style={{ fontWeight: 600, color: TH.text, marginBottom: 4 }}>Admin Only</div>
      <div>Only admins can manage this section.</div>
    </div>
  );
  const [form, setForm] = useState<any>(null);
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  function save() {
    const b = {
      ...form,
      short: form.short.toUpperCase().slice(0, 5),
    };
    if (editing === "new") setBrands((bs: any[]) => [...bs, b]);
    else setBrands((bs: any[]) => bs.map((x: any) => (x.id === editing ? b : x)));
    setEditing(null);
    setForm(null);
  }

  if (editing)
    return (
      <div>
        <div
          style={{
            fontSize: 15,
            fontWeight: 700,
            color: TH.text,
            marginBottom: 20,
          }}
        >
          {editing === "new" ? "Add Brand" : "Edit Brand"}
        </div>
        <label style={S.lbl}>Brand Name</label>
        <input
          style={S.inp}
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="e.g. Ring of Fire"
        />
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}
        >
          <div>
            <label style={S.lbl}>Short Code (up to 5 chars)</label>
            <input
              style={{ ...S.inp, marginBottom: 0 }}
              value={form.short}
              onChange={(e) =>
                set("short", e.target.value.toUpperCase().slice(0, 5))
              }
              placeholder="ROF"
            />
          </div>
          <div>
            <label style={S.lbl}>Brand Color</label>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input
                type="color"
                value={form.color}
                onChange={(e) => set("color", e.target.value)}
                style={{
                  width: 44,
                  height: 38,
                  borderRadius: 6,
                  border: `1px solid ${TH.border}`,
                  cursor: "pointer",
                  padding: 2,
                }}
              />
              <input
                style={{ ...S.inp, marginBottom: 0, flex: 1 }}
                value={form.color}
                onChange={(e) => set("color", e.target.value)}
                placeholder="#3498DB"
              />
            </div>
          </div>
        </div>
        <div style={{ height: 14 }} />
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 14px",
            background: TH.surfaceHi,
            borderRadius: 8,
            border: `1px solid ${form.isPrivateLabel ? TH.primary : TH.border}`,
            cursor: "pointer",
            marginBottom: 20,
          }}
        >
          <input
            type="checkbox"
            checked={form.isPrivateLabel}
            onChange={(e) => set("isPrivateLabel", e.target.checked)}
            style={{ accentColor: TH.primary }}
          />
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: TH.text }}>
              Private Label
            </div>
            <div style={{ fontSize: 11, color: TH.textMuted }}>
              Enables Line Review & Compliance/Testing phases
            </div>
          </div>
        </label>
        {/* Color preview */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 16px",
            background: form.color + "12",
            border: `1px solid ${form.color}44`,
            borderRadius: 10,
            marginBottom: 20,
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: "50%",
              background: form.color,
              flexShrink: 0,
            }}
          />
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: TH.text }}>
              {form.name || "Brand Name"}
            </div>
            <div style={{ fontSize: 12, color: TH.textMuted }}>
              {form.short || "CODE"}
              {form.isPrivateLabel ? " · Private Label" : ""}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
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
          <button
            disabled={!form.name || !form.short}
            onClick={save}
            style={{ ...S.btn, opacity: form.name && form.short ? 1 : 0.5 }}
          >
            Save Brand
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
          marginBottom: 16,
        }}
      >
        <span style={S.sec}>Brands ({brands.length})</span>
        <button
          onClick={() => {
            setForm(BLANK());
            setEditing("new");
          }}
          style={S.btn}
        >
          + Add Brand
        </button>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {brands.map((b: any) => (
          <div
            key={b.id}
            style={{
              ...S.card,
              display: "flex",
              alignItems: "center",
              gap: 14,
            }}
          >
            <div
              style={{
                width: 42,
                height: 42,
                borderRadius: "50%",
                background: b.color + "22",
                border: `2px solid ${b.color}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 800,
                fontSize: 12,
                color: b.color,
                flexShrink: 0,
              }}
            >
              {b.short}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: TH.text }}>
                {b.name}
              </div>
              <div style={{ fontSize: 11, color: TH.textMuted }}>
                Code: <strong>{b.short}</strong>
                {b.isPrivateLabel && (
                  <span
                    style={{ marginLeft: 8, color: "#7C3AED", fontWeight: 600 }}
                  >
                    · Private Label
                  </span>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => {
                  setForm({ ...b });
                  setEditing(b.id);
                }}
                style={{
                  padding: "5px 12px",
                  borderRadius: 7,
                  border: `1px solid ${TH.border}`,
                  background: "none",
                  color: TH.textMuted,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 12,
                }}
              >
                Edit
              </button>
              <button
                onClick={() => {
                  appConfirm("You are about to delete this brand. This action cannot be undone.", "Delete", () => setBrands((bs: any[]) => bs.filter((x: any) => x.id !== b.id)));
                }}
                style={{
                  padding: "5px 12px",
                  borderRadius: 7,
                  border: "1px solid #FCA5A5",
                  background: "none",
                  color: "#B91C1C",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 12,
                }}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
      {brands.length === 0 && (
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
          No brands yet. Add one above.
        </div>
      )}
    </div>
  );
}

export default BrandManager;
