// src/shared/colorHex.ts
//
// Best-effort colour NAME → swatch hex, client-side mirror of the
// 20260875000000_color_master_hex_swatches.sql backfill. Used to render colour
// squares (incl. two-tone "A/B" colourways split into half-and-half).

const MAP: Record<string, string> = {
  black: "#000000", white: "#ffffff", offwhite: "#f5f4ef", ivory: "#fffff0", cream: "#fffdd0", snow: "#fffafa",
  grey: "#808080", gray: "#808080", charcoal: "#36454f", graphite: "#383838", gunmetal: "#2a3439", slate: "#708090",
  steel: "#71797e", silver: "#c0c0c0", ash: "#b2beb5", smoke: "#738276", pewter: "#8a9a9a", heather: "#9aa0a8",
  navy: "#000080", blue: "#1f4e8c", cobalt: "#0047ab", royal: "#4169e1", indigo: "#3f4f8c", denim: "#3b5b80",
  sky: "#87ceeb", aqua: "#3fb7c9", teal: "#008080", turquoise: "#40e0d0", turqouise: "#40e0d0", sapphire: "#0f52ba",
  periwinkle: "#a9b3d6", azure: "#4a7fc0", cerulean: "#2a52be", mineral: "#5a7a8a", harbor: "#4a6b8a", coronet: "#5d6d9e",
  olive: "#708238", green: "#3a7d44", sage: "#9caf88", kelp: "#3d4d2a", forest: "#228b22", emerald: "#2e8b57",
  army: "#4b5320", military: "#5a5a3c", lime: "#7ac142", mint: "#9fd9b3", jade: "#3a9d7d", camo: "#4b5320",
  khaki: "#c3b091", tan: "#d2b48c", beige: "#dcc9a6", sand: "#e0cda9", camel: "#c19a6b", birch: "#d6c9a8",
  wheat: "#f0d9a0", oatmeal: "#dcd3bf", stone: "#b8ad96", sandstone: "#c9b18a", oyster: "#dbd2bd", shiitake: "#bca78a",
  mushroom: "#bfb1a0", brown: "#7b5e3b", chocolate: "#5a3a22", espresso: "#3a2a1d", coffee: "#4b3621", mocha: "#5e4636",
  walnut: "#5a4632", mahogany: "#5b3225", chestnut: "#6b4226", copper: "#b87333", rust: "#9a4a2a", bronze: "#7d5a36",
  gold: "#c8a951", dullgold: "#b29a52", yellow: "#e3c44a", mustard: "#cda434", honey: "#d6a23b", apricot: "#f0a86b",
  orange: "#d97c34", coral: "#e07a5f", peach: "#f2c1a0", salmon: "#e58a6f", pink: "#e8a0b4", blush: "#dcae9c",
  rose: "#c98a93", fuchsia: "#c2438a", magenta: "#b03a6e", lavender: "#b9a0cf", purple: "#6a4a8c", violet: "#6f5499",
  plum: "#6e3a5a", grape: "#5a2a4a", elderberry: "#4a2c3a", red: "#b23b3b", crimson: "#9b2335", burgundy: "#6e2233",
  maroon: "#5a1f2a", wine: "#5e2233", merlot: "#5b2333", oxblood: "#4a1d22", sangria: "#7a2238", tibetan: "#b23b3b",
  wash: "#5b7a99", lightwash: "#9bb3c9", medwash: "#5e7e9e", medium: "#6e7e8e", darkwash: "#34506e", dark: "#3a3a3a", light: "#cfcfcf",
  glacier: "#a9c7d1", frost: "#cfe0e3", iceberg: "#9fbfa9", abyss: "#23303a", midnight: "#1a2238", eclipse: "#2a2a33",
  falcon: "#6a5d52", typhoon: "#4a5258", horizon: "#8aa0b0", americana: "#3b4a6b", vanish: "#2f4a66", rinse: "#2a3f5c",
  // Squished abbreviations (no word boundary) seen in two-tone "A/B" colourways
  // + short codes — added so combo halves + abbreviated colours resolve.
  hthr: "#9aa0a8", chrclhthr: "#5a5f66", chrlhthr: "#5a5f66", hthrgry: "#9aa0a8", mhthrgry: "#9aa0a8",
  mdhthrgry: "#9aa0a8", mdmgryhthr: "#9aa0a8", medhthr: "#9aa0a8", mdgry: "#8a8a8a", whtcapgrey: "#b0b0b0", whtcap: "#b0b0b0",
  nv: "#000080", nvy: "#000080", wht: "#ffffff", owt: "#f5f4ef", olv: "#708238", lavndr: "#b9a0cf", lav: "#b9a0cf",
  burg: "#6e2233", brgndy: "#6e2233", burgndy: "#6e2233", khk: "#c3b091", chrcl: "#36454f", blck: "#000000",
  blk: "#000000", gry: "#808080", chrc: "#36454f", drk: "#3a3a3a",
  salsa: "#b23b3b", egret: "#efece2", peony: "#e07ba0", orchid: "#a865b0", grapewine: "#5a2a4a", grapewinemanta: "#5a2a4a",
  stormy: "#5a6470", icebrggreen: "#9fbfa9", icebergreen: "#9fbfa9", mnlssnight: "#1a2238", moonlssnights: "#1a2238",
  moonlessnights: "#1a2238", clouddancer: "#eceae0", navalacademy: "#1f3a5f", blncdeblnc: "#f5f4ef", blancdeblanc: "#f5f4ef",
  sangromni: "#7a2238", tibetanred: "#b23b3b", discharge: "#8a8a8a", dkspring: "#2e5d3a",
  dksprng: "#2e5d3a", forgetmenot: "#8aa0c8", spiral: "#b9a0cf", sparky: "#c8c8c8", spacedye: "#9aa0a8",
};

const norm = (s: string): string => String(s || "").toLowerCase().replace(/[^a-z]/g, "");

/** Best-effort hex for a single colour name (full name, then last/first/any word). Null if unknown. */
export function colorHex(name: string | null | undefined): string | null {
  if (!name) return null;
  const words = String(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const full = norm(name);
  if (MAP[full]) return MAP[full];
  for (const w of [words[words.length - 1], words[0], ...words]) if (w && MAP[w]) return MAP[w];
  return null;
}

/** Split a two-tone colourway name ("Grey/Black") into its parts. One part for a plain colour. */
export function splitColorName(name: string | null | undefined): string[] {
  if (!name) return [];
  return String(name).split("/").map((s) => s.trim()).filter(Boolean);
}
