// Static config for the TechPack app. Status enums, status → color
// maps, approval stage list, sample types, material types, swatch
// palette, category/season dropdown sources, default size scale.
//
// Originally inline in TechPack.tsx — extracting them avoids the
// 4k-line monolith carrying its own per-render allocations and lets
// future panel splits import the same canonical lists.

import type { Sample, TechPack } from "./types";

export const STATUSES: TechPack["status"][] = ["Draft", "In Review", "Approved", "Revised"];

export const STATUS_COLORS: Record<string, string> = {
  Draft:        "#6B7280",
  "In Review":  "#F59E0B",
  Approved:     "#10B981",
  Revised:      "#8B5CF6",
};

export const APPROVAL_STAGES = ["Design", "Merchandising", "Buying", "Production", "Quality"];

export const APPROVAL_STATUS_COLORS: Record<string, string> = {
  Pending:                 "#6B7280",
  Approved:                "#10B981",
  Rejected:                "#EF4444",
  "Revision Required":     "#F59E0B",
};

export const SAMPLE_TYPES: Sample["type"][] = ["Proto", "SMS", "PP", "TOP", "Production"];

export const SAMPLE_STATUS_COLORS: Record<string, string> = {
  Requested:     "#6B7280",
  "In Progress": "#3B82F6",
  Received:      "#F59E0B",
  Approved:      "#10B981",
  Rejected:      "#EF4444",
};

export const MATERIAL_TYPES = [
  "Fabric", "Trim", "Label", "Thread", "Zipper", "Button",
  "Elastic", "Interlining", "Packaging", "Other",
];

// Swatch palette for new colorway badges.
export const CW_COLORS = [
  "#3B82F6", "#10B981", "#F59E0B", "#8B5CF6",
  "#EF4444", "#06B6D4", "#F97316", "#EC4899",
];

export const CATEGORIES = [
  "Tops", "Bottoms", "Dresses", "Outerwear",
  "Activewear", "Swimwear", "Accessories", "Other",
];

export const SEASONS = [
  "Spring 2025", "Summer 2025", "Fall 2025", "Winter 2025",
  "Spring 2026", "Summer 2026", "Fall 2026", "Winter 2026",
  "Resort 2025", "Resort 2026",
];

export const DEFAULT_SIZES = ["XS", "S", "M", "L", "XL", "XXL"];
