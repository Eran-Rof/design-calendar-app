import React, { useState } from "react";
import { TH } from "../utils/theme";
import { appConfirm } from "../utils/theme";
import { S } from "../utils/styles";
import { DEFAULT_CATEGORIES } from "../utils/constants";
import { uid } from "../utils/dates";

// ─── CATEGORY MANAGER ────────────────────────────────────────────────────────
function CategoryManager({ categories, setCategories, isAdmin = false }) {
  const [newCat, setNewCat] = useState("");
  if (!isAdmin) return (
    <div style={{ padding: "20px", textAlign: "center", color: TH.textMuted, fontSize: 13 }}>
      <div style={{ fontSize: 24, marginBottom: 8 }}>🔒</div>
      <div style={{ fontWeight: 600, color: TH.text, marginBottom: 4 }}>Admin Only</div>
      <div>Only admins can manage this section.</div>
    </div>
  );
  const [newSub, setNewSub] = useState({});
  const [editCat, setEditCat] = useState(null); // {id, name}
  const [editName, setEditName] = useState("");

  function addCategory() {
    const name = newCat.trim();
    if (!name || categories.find((c) => c.name === name)) return;
    setCategories((cs) => [...cs, { id: uid(), name, subCategories: [] }]);
    setNewCat("");
  }
  function deleteCategory(id) {
    appConfirm("You are about to delete this category and all its subcategories. This action cannot be undone.", "Delete", () => setCategories((cs) => cs.filter((c) => c.id !== id)));
    return;
  }
  function renameCategory(id, name) {
    setCategories((cs) => cs.map((c) => (c.id === id ? { ...c, name } : c)));
    setEditCat(null);
  }
  function addSubCategory(catId) {
    const name = (newSub[catId] || "").trim();
    if (!name) return;
    setCategories((cs) =>
      cs.map((c) =>
        c.id === catId && !c.subCategories.includes(name)
          ? { ...c, subCategories: [...c.subCategories, name] }
          : c
      )
    );
    setNewSub((s) => ({ ...s, [catId]: "" }));
  }
  function deleteSubCategory(catId, sub) {
    appConfirm(`You are about to delete the subcategory "${sub}". This action cannot be undone.`, "Delete", () => {
      setCategories((cs) =>
        cs.map((c) =>
          c.id === catId
            ? { ...c, subCategories: c.subCategories.filter((s) => s !== sub) }
            : c
        )
      );
    });
    return;
  }

  return (
    <div>
      <div style={{ fontSize: 13, color: TH.textMuted, marginBottom: 16 }}>
        Manage categories and sub-categories used across vendors and SKUs.
      </div>
      {/* Add new category */}
      <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
        <input
          style={{ ...S.inp, marginBottom: 0, flex: 1 }}
          placeholder="New category name..."
          value={newCat}
          onChange={(e) => setNewCat(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addCategory()}
        />
        <button
          onClick={addCategory}
          style={{ ...S.btn, whiteSpace: "nowrap" }}
        >
          + Add Category
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {categories.map((cat) => (
          <div key={cat.id} style={{ ...S.card, padding: "14px 16px" }}>
            {/* Category header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 10,
              }}
            >
              {editCat === cat.id ? (
                <>
                  <input
                    autoFocus
                    style={{
                      ...S.inp,
                      marginBottom: 0,
                      flex: 1,
                      fontSize: 14,
                      fontWeight: 700,
                    }}
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") renameCategory(cat.id, editName);
                      if (e.key === "Escape") setEditCat(null);
                    }}
                  />
                  <button
                    onClick={() => renameCategory(cat.id, editName)}
                    style={{ ...S.btn, padding: "5px 12px", fontSize: 12 }}
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setEditCat(null)}
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
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <span
                    style={{
                      flex: 1,
                      fontSize: 15,
                      fontWeight: 700,
                      color: TH.text,
                    }}
                  >
                    {cat.name}
                  </span>
                  <button
                    onClick={() => {
                      setEditCat(cat.id);
                      setEditName(cat.name);
                    }}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      border: `1px solid ${TH.border}`,
                      background: "none",
                      color: TH.textMuted,
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontSize: 12,
                    }}
                  >
                    ✏️ Rename
                  </button>
                  <button
                    onClick={() => deleteCategory(cat.id)}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      border: "1px solid #FCA5A5",
                      background: "none",
                      color: "#B91C1C",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontSize: 12,
                    }}
                  >
                    🗑️ Delete
                  </button>
                </>
              )}
            </div>
            {/* Sub-categories */}
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                marginBottom: 8,
              }}
            >
              {(cat.subCategories || []).map((sub) => (
                <div
                  key={sub}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "3px 10px",
                    borderRadius: 16,
                    border: `1px solid ${TH.border}`,
                    background: TH.surfaceHi,
                    fontSize: 12,
                    color: TH.textSub,
                  }}
                >
                  {sub}
                  <button
                    onClick={() => deleteSubCategory(cat.id, sub)}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#B91C1C",
                      cursor: "pointer",
                      fontSize: 13,
                      lineHeight: 1,
                      padding: "0 0 0 3px",
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
              {(cat.subCategories || []).length === 0 && (
                <span
                  style={{
                    fontSize: 12,
                    color: TH.textMuted,
                    fontStyle: "italic",
                  }}
                >
                  No sub-categories yet
                </span>
              )}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                style={{
                  ...S.inp,
                  marginBottom: 0,
                  flex: 1,
                  fontSize: 12,
                  padding: "5px 10px",
                }}
                placeholder="Add sub-category..."
                value={newSub[cat.id] || ""}
                onChange={(e) =>
                  setNewSub((s) => ({ ...s, [cat.id]: e.target.value }))
                }
                onKeyDown={(e) => e.key === "Enter" && addSubCategory(cat.id)}
              />
              <button
                onClick={() => addSubCategory(cat.id)}
                style={{
                  padding: "5px 12px",
                  borderRadius: 7,
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
                + Sub
              </button>
            </div>
          </div>
        ))}
        {categories.length === 0 && (
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
            No categories yet. Add one above.
          </div>
        )}
      </div>
    </div>
  );
}


export default CategoryManager;
