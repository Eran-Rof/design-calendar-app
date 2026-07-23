// src/inventory-planning/utils/tangerineTaxonomy.ts
//
// Overlay Tangerine's Style Master taxonomy onto planning items.
//
// Planning's Category / Sub-cat previously came ONLY from the nightly Xoro
// master sync (attributes.group_name = Xoro GroupName, attributes.category_name
// = Xoro CategoryName). Xoro's taxonomy and Tangerine's `style_master`
// (Group → Category → Sub Category) drift — a 2026-07 audit found 14.9k of
// 26.7k items whose Xoro values matched NOTHING in the current Tangerine
// taxonomy, so the planning filters showed a stale mix ("categories don't
// match Tangerine").
//
// This overlay makes Tangerine the source of truth at load time:
//   planning "Category"  (reader: attributes.group_name)    ← style_master.category_name
//   planning "Sub cat"   (reader: attributes.category_name) ← style_master.sub_category_name
// Items whose style has no style_master row keep their Xoro attributes as the
// fallback. Applied at the REPO BOUNDARY — inside wholesaleRepo.listItems()
// (and mirrored in listMasterStyles) — so every consumer (grid display,
// filters, build seeding, forecast pass, supply reconciliation, reports)
// reads the same corrected Category/Sub-cat without per-caller wiring.

export interface TangerineTaxonomyEntry {
  category_name: string | null;
  sub_category_name: string | null;
}
/** Keyed by UPPER-CASED trimmed style_code. */
export type TangerineTaxonomy = Map<string, TangerineTaxonomyEntry>;

export function taxonomyKey(styleCode: string | null | undefined): string {
  return (styleCode ?? "").trim().toUpperCase();
}

export function applyTangerineTaxonomy<T extends { style_code?: string | null; attributes?: unknown }>(
  items: T[],
  tax: TangerineTaxonomy,
): T[] {
  if (tax.size === 0) return items;
  return items.map((it) => {
    const t = tax.get(taxonomyKey(it.style_code));
    if (!t || (!t.category_name && !t.sub_category_name)) return it;
    const attrs = { ...((it.attributes as Record<string, unknown> | null) ?? {}) };
    if (t.category_name) attrs.group_name = t.category_name;
    if (t.sub_category_name) attrs.category_name = t.sub_category_name;
    return { ...it, attributes: attrs };
  });
}
