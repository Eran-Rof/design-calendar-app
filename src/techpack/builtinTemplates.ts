// Built-in spec-sheet templates shipped with the app. Today there's
// just the Men's Jeans template (24 POMs across 6 sections); future
// templates land here as additional entries.
//
// Extracted from TechPack.tsx — keeping the templates in their own
// module makes adding / editing them safer (no risk of breaking the
// main component) and feeds the SpecTemplate library list.

import type { SpecSheetRow, SpecTemplate } from "./types";

// Jeans size scale — waist measurements 28–48.
const _JS = ["28","29","30","31","32","33","34","35","36","38","40","42","44","46","48"];

// Row + section helpers. Underscore prefix mirrors the original
// inline names so a `git blame` jump still lands somewhere sensible.
const _mkR = (id: string, pom: string, desc: string, tol: string): SpecSheetRow => ({
  id,
  pointOfMeasure: `${pom}  ${desc}`,
  tolerance: tol,
  values: Object.fromEntries(_JS.map(s => [s, ""])),
});

const _mkS = (id: string, name: string): SpecSheetRow => ({
  id,
  pointOfMeasure: name,
  tolerance: "",
  values: {},
  isSection: true,
});

export const BUILTIN_TEMPLATES: SpecTemplate[] = [
  {
    id: "builtin-mens-jeans-1",
    name: "Men's Jeans",
    category: "Bottoms",
    description: "Men's Baggy Jeans — 24 POMs across 6 sections (Waist/Rise, Hip/Thigh, Inseam/Leg, Waistband, Front Pockets, Back Pockets/Yoke)",
    sizes: _JS,
    isBuiltin: true,
    createdAt: "2026-01-01",
    rows: [
      _mkS("bt-s1", "① BODY — WAIST & RISE"),
      _mkR("bt-r1",  "A",  "Waist Along Top Edge",                   "1/2\""),
      _mkR("bt-r2",  "H",  "Front Rise Incl. Waistband",             "1/4\""),
      _mkS("bt-s2", "② HIP & THIGH"),
      _mkR("bt-r4",  "B",  "Low Hip — 6\" Below Waistband",          "1/2\""),
      _mkR("bt-r5",  "C",  "Thigh — 1\" Below Crotch",               "1/4\""),
      _mkS("bt-s3", "③ INSEAM & LEG"),
      _mkR("bt-r7",  "E",  "Knee — 15\" Below Crotch",               "1/4\""),
      _mkR("bt-r8",  "F",  "Inseam",                                 "1/4\""),
      _mkS("bt-s4", "④ WAISTBAND DETAILS"),
      _mkR("bt-r10", "J",  "Waistband Height",                       "1/8\""),
      _mkR("bt-r11", "K",  "Fly J-Stitch Length",                    "1/8\""),
      _mkR("bt-r12", "N",  "Zipper Length (Fly)",                    "1/8\""),
      _mkS("bt-s5", "⑤ FRONT POCKETS"),
      _mkR("bt-r14", "O",  "Front Pocket Opening (Horiz @ WB)",      "1/8\""),
      _mkR("bt-r15", "P",  "Front Pocket Opening (Vert @ SS)",       "1/8\""),
      _mkR("bt-r16", "Q",  "Front Pocket Bag Depth",                 "1/8\""),
      _mkR("bt-r17", "Q",  "Front Pocket Bag Width",                 "1/8\""),
      _mkR("bt-r18", "R",  "Coin Pocket Placement from WB Seam",     "1/8\""),
      _mkR("bt-r19", "L",  "Coin Pocket Placement from SS",          "1/8\""),
      _mkS("bt-s6", "⑥ BACK POCKETS & YOKE"),
      _mkR("bt-r21", "U",  "BK Pocket Spread (Apart)",               "1/8\""),
      _mkR("bt-r22", "V",  "Back Yoke Height at CB",                 "1/8\""),
      _mkR("bt-r23", "W",  "Back Yoke Height at SS",                 "1/8\""),
      _mkR("bt-r24", "X",  "BK Pocket Placement from WB — CB",       "1/8\""),
      _mkR("bt-r25", "Y",  "BK Pocket Placement from WB — SS",       "1/8\""),
      _mkR("bt-r26", "Z",  "Back Pocket Height at Center",           "1/8\""),
      _mkR("bt-r27", "AA", "Back Pocket Height at Sides",            "1/8\""),
      _mkR("bt-r28", "BB", "Back Pocket Width at Top",               "1/8\""),
      _mkR("bt-r29", "CC", "Back Pocket Width at Bottom",            "1/8\""),
    ],
  },
];
