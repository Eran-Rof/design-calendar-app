// ─── THEME D: SLATE BLUE & RED ────────────────────────────────────────────────
export const TH = {
  bg: "#4A5568",
  surface: "#FFFFFF",
  surfaceHi: "#F7F8FA",
  border: "#CBD5E0",
  header: "#2D3748",
  primary: "#C8210A",
  primaryLt: "#E02B10",
  text: "#1A202C",
  textSub: "#2D3748",
  textSub2: "#4A5568",
  textMuted: "#718096",
  accent: "#FFF5F5",
  accentBdr: "#FEB2B2",
  shadow: "rgba(0,0,0,0.12)",
  shadowMd: "rgba(0,0,0,0.18)",
};

// ─── TEAMS BRAND COLORS ──────────────────────────────────────────────────────
export const TEAMS_PURPLE = "#5b5ea6";
export const TEAMS_PURPLE_LT = "#7b83eb";
export const OUTLOOK_BLUE = "#0078D4";
export const OUTLOOK_BLUE_LT = "#106EBE";

// ─── CUSTOMER → CHANNEL TYPE MAP ─────────────────────────────────────────────
export const CUSTOMER_CHANNEL_MAP: Record<string, string> = {
  "Macy's": "Department Store",
  Nordstrom: "Department Store",
  JCPenney: "Department Store",
  Belk: "Department Store",
  "Kohl's": "Department Store",
  Ross: "Off-Price (Ross, TJX)",
  "TJ Maxx": "Off-Price (Ross, TJX)",
  Burlington: "Off-Price (Ross, TJX)",
  Target: "E-Commerce",
  Amazon: "E-Commerce",
};

// ─── GLOBAL CONFIRM ─────────────────────────────────────────────────────────
let _showConfirm: (opts: { message: string; action: string; onConfirm: () => void }) => void = () => {};

export function setConfirmHandler(fn: (opts: { message: string; action: string; onConfirm: () => void }) => void) {
  _showConfirm = fn;
}

export function appConfirm(message: string, action: string, onConfirm: () => void) {
  _showConfirm({ message, action, onConfirm });
}
