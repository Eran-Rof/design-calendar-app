import React from "react";
import { TH } from "../../utils/theme";
import { useGS1Store, type GS1Tab } from "../store/gs1Store";
import { useAppUnreadCount } from "../../components/notifications/useAppUnreadCount";
import { supabaseClient } from "../../utils/supabase";
import { usePersonalization } from "../../hooks/usePersonalization";
import { gs1ViewToMenuKey } from "../../lib/gs1ViewToMenuKey";
import FavoritesMenu from "../../components/FavoritesMenu";

const TABS: Array<{ id: GS1Tab; label: string }> = [
  { id: "company",   label: "Company Setup" },
  { id: "upc",       label: "UPC Master" },
  { id: "scale",     label: "Scale Master" },
  { id: "gtins",     label: "Pack GTINs" },
  { id: "upload",    label: "Packing List" },
  { id: "pa_unpacker", label: "PA Unpacker" },
  { id: "labels",    label: "Label Batches" },
  { id: "templates", label: "Label Templates" },
  { id: "cartons",   label: "Carton Labels" },
  { id: "receiving",   label: "Receiving" },
  { id: "exceptions",  label: "Exceptions" },
];

function readPlmUserId(): string | null {
  try {
    const u = sessionStorage.getItem("plm_user");
    return u ? (JSON.parse(u) as { id?: string }).id || null : null;
  } catch { return null; }
}

export default function GS1NavBar() {
  const activeTab   = useGS1Store(s => s.activeTab);
  const setActiveTabRaw = useGS1Store(s => s.setActiveTab);
  // Cross-cutter T4-5 — personalization. Fire-and-forget menu-click
  // telemetry. Mapped tabs hit /api/internal/users/me/menu-click;
  // unmapped tabs silently skip via the null-returning mapper.
  const { logClick: logGs1MenuClick } = usePersonalization();
  const setActiveTab = (tab: GS1Tab) => {
    const mk = gs1ViewToMenuKey(tab);
    if (mk) logGs1MenuClick(mk);
    setActiveTabRaw(tab);
  };
  const userId = readPlmUserId();
  const unread = useAppUnreadCount({
    supabase: supabaseClient,
    userId,
    recipientColumn: "recipient_internal_id",
    app: "gs1",
  });

  return (
    <div style={{
      background: TH.header,
      color: "#fff",
      display: "flex",
      alignItems: "center",
      padding: "0 16px",
      height: 52,
      boxShadow: `0 2px 8px ${TH.shadow}`,
      flexShrink: 0,
      gap: 8,
    }}>
      <a href="/" style={{ color: "#fff", textDecoration: "none", fontSize: 13, marginRight: 16, opacity: 0.7 }}>
        ← PLM
      </a>
      <span style={{ fontWeight: 700, fontSize: 15, marginRight: 20 }}>
        GS1 Prepack Labels
      </span>
      {/* Favorites — first action icon (consistent across all apps). */}
      <FavoritesMenu />
      <div style={{ display: "flex", gap: 2 }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              background: activeTab === tab.id ? TH.primary : "transparent",
              color: activeTab === tab.id ? "#fff" : "rgba(255,255,255,0.75)",
              border: "none",
              borderRadius: 6,
              padding: "6px 14px",
              fontSize: 13,
              fontWeight: activeTab === tab.id ? 600 : 400,
              cursor: "pointer",
              transition: "all 0.15s",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <button
        onClick={() => setActiveTab("notifications")}
        title="Notifications"
        style={{
          marginLeft: "auto",
          background: activeTab === "notifications" ? TH.primary : "transparent",
          color: activeTab === "notifications" ? "#fff" : "rgba(255,255,255,0.85)",
          border: "1px solid rgba(255,255,255,0.18)",
          borderRadius: 6,
          padding: "6px 12px",
          fontSize: 13,
          fontWeight: activeTab === "notifications" ? 600 : 500,
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        Notifications
        {unread > 0 && (
          <span style={{
            minWidth: 18, height: 18, padding: "0 5px", borderRadius: 999,
            background: "#EF4444", color: "#fff", fontSize: 10, fontWeight: 700,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
          }}>{unread > 9 ? "9+" : unread}</span>
        )}
      </button>
    </div>
  );
}
