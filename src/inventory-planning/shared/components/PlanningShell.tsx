// PlanningShell — thin chrome wrapper used by every /planning/* route.
//
// Adds the same notifications affordances every other internal app
// has: a 🔔 Notifications header button with unread badge, a card-
// grouped in-app inbox filtered to planning-relevant events, and the
// background NotificationsShell for toast delivery. Wraps the panel
// passed in as children so individual workbenches stay focused on
// their own data and don't each need to wire notifications themselves.

import { useState, type ReactNode } from "react";
import NotificationsPage from "../../../components/notifications/NotificationsPage";
import NotificationsShell from "../../../components/notifications/NotificationsShell";
import { useAppUnreadCount } from "../../../components/notifications/useAppUnreadCount";
import { supabaseClient } from "../../../utils/supabase";

function readPlmUserId(): string | null {
  try {
    const u = sessionStorage.getItem("plm_user");
    return u ? (JSON.parse(u) as { id?: string }).id || null : null;
  } catch { return null; }
}

interface Props {
  /** Section label shown in the header (e.g. "Wholesale Planning"). */
  title: string;
  children: ReactNode;
}

export default function PlanningShell({ title, children }: Props) {
  const userId = readPlmUserId();
  const [showNotifs, setShowNotifs] = useState(false);
  const unread = useAppUnreadCount({
    supabase: supabaseClient,
    userId,
    recipientColumn: "recipient_internal_id",
    app: "planning",
  });

  return (
    <div style={{ minHeight: "100vh", background: "#0F172A" }}>
      <header style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 18px",
        background: "#111827",
        borderBottom: "1px solid #1F2937",
        gap: 12,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, color: "#E5E7EB" }}>
          <a href="/" style={{ color: "rgba(255,255,255,0.7)", textDecoration: "none", fontSize: 13 }}>← PLM</a>
          <span style={{ fontWeight: 700, fontSize: 14, color: "#F9FAFB" }}>{title}</span>
        </div>
        <button
          onClick={() => setShowNotifs((v) => !v)}
          title="Notifications"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 12px",
            borderRadius: 6,
            border: "1px solid rgba(255,255,255,0.18)",
            background: showNotifs ? "#3B82F620" : "transparent",
            color: showNotifs ? "#60A5FA" : "rgba(255,255,255,0.85)",
            cursor: "pointer",
            fontSize: 13,
            fontWeight: showNotifs ? 600 : 500,
            fontFamily: "inherit",
          }}
        >
          🔔 Notifications
          {unread > 0 && (
            <span style={{
              minWidth: 18, height: 18, padding: "0 5px", borderRadius: 999,
              background: "#EF4444", color: "#fff", fontSize: 10, fontWeight: 700,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
            }}>{unread > 9 ? "9+" : unread}</span>
          )}
        </button>
      </header>

      {showNotifs && supabaseClient && userId ? (
        <div style={{ padding: 24 }}>
          <NotificationsPage
            embed
            kind="internal"
            supabase={supabaseClient}
            userId={userId}
            title="Notifications"
            appFilter="planning"
          />
        </div>
      ) : (
        children
      )}

      {supabaseClient && userId && (
        <NotificationsShell
          kind="internal"
          supabase={supabaseClient}
          userId={userId}
          notificationsUrl="/notifications?from=planning"
          currentPath={typeof window !== "undefined" ? window.location.pathname : undefined}
          isViewingNotifications={showNotifs}
          sessionKey="rof_notif_dismissed_internal"
          autoOpen={false}
          appFilter="planning"
        />
      )}
    </div>
  );
}
