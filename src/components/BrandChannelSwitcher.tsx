// src/components/BrandChannelSwitcher.tsx
//
// P15 Brand Master — Chunk 2: global Brand + Channel pickers.
//
// Two compact dropdowns in the top bar. Selecting a brand/channel writes the
// per-tab choice (sessionStorage) which installInternalApiAuth attaches as
// X-Brand-ID / X-Channel-ID on every /api/internal call. "All" = no filter.
//
// In chunk 2 nothing filters (silent-log) — the picker just records the choice
// and shows it. Chunk 3 turns on per-report WHERE brand_id = <selected>.
//
// Mounted in the Tangerine ERP shell (the brand-reporting surface). Positioned
// to sit just left of where <EntitySwitcher> renders so they don't collide.

import type React from "react";
import { useBrandContext } from "../hooks/useBrandContext";
import SearchableSelect from "../tanda/components/SearchableSelect";

const C = {
  panel: "#1E293B", border: "#334155", text: "#F1F5F9",
  textDim: "#94A3B8", accent: "#3B82F6",
};

const selStyle: React.CSSProperties = {
  background: C.panel, color: C.text, border: `1px solid ${C.border}`,
  borderRadius: 8, padding: "6px 8px", fontSize: 12, fontWeight: 600,
  cursor: "pointer", colorScheme: "dark", maxWidth: 150,
};

interface BrandChannelSwitcherProps {
  /** When true the outer wrapper is relative/inline instead of position:fixed */
  inline?: boolean;
}

export default function BrandChannelSwitcher({ inline = false }: BrandChannelSwitcherProps) {
  const { brands, channels, currentBrandId, currentChannelId, selectBrand, selectChannel, loading } =
    useBrandContext();

  // No chrome until the brand list has loaded (and only if there's >1 brand).
  if (loading && brands.length === 0) return null;
  if (brands.length <= 1) return null;

  return (
    <div
      data-testid="brand-channel-switcher"
      style={inline ? {
        position: "relative",
        display: "flex", gap: 6, alignItems: "center", fontFamily: "inherit",
        borderRadius: 8,
      } : {
        position: "fixed", top: 12, right: 16, zIndex: 60,
        display: "flex", gap: 6, alignItems: "center", fontFamily: "inherit",
        boxShadow: "0 4px 12px rgba(0,0,0,0.3)", borderRadius: 8,
      }}
    >
      <div title="Filter by brand" style={{ maxWidth: 150 }}>
        <SearchableSelect
          theme="light"
          value={currentBrandId ?? null}
          onChange={(v) => selectBrand(v || null)}
          options={[
            { value: "", label: "All brands" },
            ...brands.map((b) => ({ value: b.id, label: b.name })),
          ]}
          inputStyle={selStyle}
        />
      </div>

      <div title="Filter by channel" style={{ maxWidth: 150 }}>
        <SearchableSelect
          theme="light"
          value={currentChannelId ?? null}
          onChange={(v) => selectChannel(v || null)}
          options={[
            { value: "", label: "All channels" },
            ...channels.map((c) => ({ value: c.id, label: c.name })),
          ]}
          inputStyle={selStyle}
        />
      </div>
    </div>
  );
}
