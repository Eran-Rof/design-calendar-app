// Item-master attribute readers. Pulls fields out of the JSONB
// `attributes` column on ip_item_master items (and shapes derived
// from it). Null-safe so callers don't break on items created by
// sync stubs before the Excel master upload populated these.
//
// `group_name`     → Category (high-level merch group, e.g. "DENIM")
// `category_name`  → Sub Cat (e.g. "SLIM", "SKINNY")
// `gender`         → "Mens" | "Womens" | "Unisex" | etc.
//
// Naming reflects the planner's UI convention, NOT the underlying
// JSONB key — keep both panels using the same shaped reader so a
// rename in one place propagates everywhere.

type AttrBag = { attributes?: Record<string, unknown> | null } | null | undefined;

function readStringAttr(item: AttrBag, key: string): string | null {
  const v = item?.attributes && (item.attributes as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function readGroupName(item: AttrBag): string | null {
  return readStringAttr(item, "group_name");
}
export function readSubCategoryName(item: AttrBag): string | null {
  return readStringAttr(item, "category_name");
}
export function readGender(item: AttrBag): string | null {
  return readStringAttr(item, "gender");
}
