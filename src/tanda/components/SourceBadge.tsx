// src/tanda/components/SourceBadge.tsx
//
// Cross-cutter T10-7 — small colored chip showing a row's `source` field,
// embedded inline in the existing label cell on AR/AP/JE list panels.
//
// The `source` column was added to every mutable sub-ledger by T10-1 with
// values from the canonical enum: 'manual' | 'xoro_mirror' | 'shopify' |
// 'fba' | 'walmart' | 'faire' | 'edi_3pl' | 'plaid_sync' | 'api' | 'system'.
// Operator wants to see at a glance whether a row was typed in the UI
// ('manual') vs landed via an integration ('xoro_mirror' for v1, more
// coming in P11/P12/P22).
//
// Visual: compact (height ~16px), rounded, tinted background with white
// text. Renders nothing for nullish or empty values so older rows that
// haven't been touched since the T10-1 migration aren't visually noisy.

export const SOURCE_COLOR: Record<string, string> = {
  manual:      "#94A3B8", // gray
  xoro_mirror: "#3B82F6", // blue
  shopify:     "#10B981", // green
  fba:         "#F59E0B", // amber
  walmart:     "#EAB308", // yellow
  faire:       "#A855F7", // purple
  edi_3pl:     "#EF4444", // red
  plaid_sync:  "#06B6D4", // cyan
  api:         "#EC4899", // pink
  system:      "#6B7280", // dark gray
};

// Short labels — full names are too long for an inline chip.
const SOURCE_LABEL: Record<string, string> = {
  manual:      "manual",
  xoro_mirror: "xoro",
  shopify:     "shopify",
  fba:         "fba",
  walmart:     "walmart",
  faire:       "faire",
  edi_3pl:     "edi",
  plaid_sync:  "plaid",
  api:         "api",
  system:      "system",
};

export const SOURCE_OPTIONS = [
  "manual",
  "xoro_mirror",
  "shopify",
  "fba",
  "walmart",
  "faire",
  "edi_3pl",
  "plaid_sync",
  "api",
  "system",
] as const;

export type SourceValue = (typeof SOURCE_OPTIONS)[number];

export default function SourceBadge({ source }: { source: string | null | undefined }) {
  if (!source) return null;
  const color = SOURCE_COLOR[source] || "#6B7280";
  const label = SOURCE_LABEL[source] || source;
  return (
    <span
      title={`source = ${source}`}
      style={{
        display: "inline-block",
        background: color,
        color: "white",
        fontSize: 10,
        fontWeight: 600,
        padding: "1px 6px",
        borderRadius: 8,
        marginLeft: 6,
        textTransform: "lowercase",
        letterSpacing: 0.3,
        verticalAlign: "middle",
        lineHeight: 1.4,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}
