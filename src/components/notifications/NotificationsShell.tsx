// NotificationsShell — background service component.
//
// Drop once per app. No UI overlay. Responsibilities:
//   1. Poll the notifications table every 30 s.
//   2. If unread > 0 on the first mount after a full page load and the
//      user is not already on the notifications page, navigate to
//      `notificationsUrl` so pending items are the first thing seen.
//   3. Show a "🔔 New notification · View / Close" toast when a new
//      notification arrives while the user is already in the app and
//      not already on the notifications page.
//
// The bell / counter / list UI now live in a dedicated route
// (see NotificationsPage.tsx) — this component does not render a
// floating overlay anymore.

import { useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NotificationRow } from "./types";

interface Props {
  kind: "vendor" | "internal";
  supabase: SupabaseClient;
  userId: string | null;
  /** URL of the dedicated notifications page, e.g. "/vendor/notifications"
   *  for vendor, "/notifications" for internal apps. */
  notificationsUrl: string;
  /** Current path — used to suppress toast + auto-redirect while the
   *  user is already viewing the notifications page. */
  currentPath?: string;
  /** Kept for backwards compatibility; no longer used to suppress auto-open. */
  sessionKey?: string;
}

export default function NotificationsShell({
  kind, supabase, userId, notificationsUrl, currentPath,
}: Props) {
  const [toast, setToast] = useState<NotificationRow | null>(null);
  const lastSeenCreatedAt = useRef<string | null>(null);
  const autoRedirectedThisMount = useRef(false);

  const recipientColumn = kind === "vendor" ? "recipient_auth_id" : "recipient_internal_id";
  const onNotificationsPage =
    !!currentPath &&
    (currentPath === notificationsUrl || currentPath.startsWith(notificationsUrl + "/") || currentPath.startsWith(notificationsUrl + "?"));

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    async function load() {
      const { data, error } = await supabase
        .from("notifications")
        .select("id, event_type, title, body, link, read_at, created_at, recipient_auth_id, recipient_internal_id, metadata")
        .eq(recipientColumn, userId)
        .order("created_at", { ascending: false })
        .limit(20);
      if (cancelled || error) return;
      const list = (data ?? []) as NotificationRow[];

      // New-arrival toast — anything unread AND newer than the last
      // created_at we've observed since mount.
      const prev = lastSeenCreatedAt.current;
      if (prev) {
        const newer = list.filter((n) => n.created_at > prev && !n.read_at);
        if (newer.length > 0 && !onNotificationsPage) setToast(newer[0]);
      }
      if (list.length > 0) lastSeenCreatedAt.current = list[0].created_at;

      // Auto-redirect to the notifications page on the first mount
      // (i.e. first fetch after a fresh page load) when unread > 0.
      // Fires once per mount — SPA navigation away from notifications
      // won't pull the user back because the shell doesn't remount.
      if (!autoRedirectedThisMount.current) {
        autoRedirectedThisMount.current = true;
        const unread = list.filter((n) => !n.read_at).length;
        if (unread > 0 && !onNotificationsPage) {
          window.location.href = notificationsUrl;
        }
      }
    }
    void load();
    const i = window.setInterval(load, 30_000);
    return () => { cancelled = true; window.clearInterval(i); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, kind, notificationsUrl]);

  if (!userId || !toast || onNotificationsPage) return null;

  return <NewNotificationToast notification={toast} onView={() => { window.location.href = notificationsUrl; }} onClose={() => setToast(null)} />;
}

function NewNotificationToast({
  notification, onView, onClose,
}: {
  notification: NotificationRow;
  onView: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onClose, 8000);
    return () => clearTimeout(t);
  }, [notification.id, onClose]);

  return (
    <div style={{
      position: "fixed",
      bottom: 24,
      right: 24,
      zIndex: 10001,
      minWidth: 320,
      maxWidth: 420,
      background: "#1E293B",
      color: "#F1F5F9",
      border: "1px solid #3B82F6",
      borderRadius: 10,
      boxShadow: "0 14px 40px rgba(0,0,0,0.55)",
      padding: "14px 16px",
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      <div style={{ fontSize: 10, color: "#60A5FA", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
        🔔 New notification
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>{notification.title}</div>
      {notification.body && (
        <div style={{ fontSize: 12, color: "#CBD5E1", marginBottom: 10, lineHeight: 1.4 }}>
          {notification.body.length > 140 ? notification.body.slice(0, 140) + "…" : notification.body}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
        <button onClick={onClose} style={{
          padding: "5px 12px", borderRadius: 5, border: "1px solid #475569",
          background: "transparent", color: "#CBD5E1", cursor: "pointer",
          fontSize: 12, fontWeight: 600, fontFamily: "inherit",
        }}>Close</button>
        <button onClick={onView} style={{
          padding: "5px 14px", borderRadius: 5, border: "none",
          background: "#3B82F6", color: "#fff", cursor: "pointer",
          fontSize: 12, fontWeight: 700, fontFamily: "inherit",
        }}>View</button>
      </div>
    </div>
  );
}
