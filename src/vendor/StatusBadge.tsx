import { TH } from "./theme";

type Tone = "info" | "warn" | "ok" | "muted" | "danger";

const TONE: Record<Tone, { bg: string; fg: string; bdr: string }> = {
  info:   { bg: "#EBF4FF", fg: "#2B6CB0", bdr: "#BEE3F8" },
  warn:   { bg: "#FFFAF0", fg: "#C05621", bdr: "#FED7AA" },
  ok:     { bg: "#F0FFF4", fg: "#276749", bdr: "#C6F6D5" },
  muted:  { bg: "#F7FAFC", fg: "#4A5568", bdr: "#E2E8F0" },
  danger: { bg: TH.accent, fg: TH.primary, bdr: TH.accentBdr },
};

export default function StatusBadge({ label, tone = "muted" }: { label: string; tone?: Tone }) {
  const t = TONE[tone];
  return (
    <span style={{ display: "inline-block", padding: "3px 8px", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.04, borderRadius: 4, background: t.bg, color: t.fg, border: `1px solid ${t.bdr}` }}>
      {label}
    </span>
  );
}

export function contractTone(status: string): Tone {
  if (status === "signed") return "ok";
  if (status === "sent")   return "info";
  if (status === "under_review") return "warn";
  if (status === "expired" || status === "terminated") return "muted";
  return "muted";
}

export function disputeTone(status: string): Tone {
  if (status === "open") return "warn";
  if (status === "under_review") return "info";
  if (status === "resolved") return "ok";
  if (status === "closed") return "muted";
  return "muted";
}

export function bulkTone(status: string): Tone {
  if (status === "queued" || status === "processing") return "info";
  if (status === "complete") return "ok";
  if (status === "failed") return "danger";
  return "muted";
}
