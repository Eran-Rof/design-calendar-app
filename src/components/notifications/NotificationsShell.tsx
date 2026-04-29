// NotificationsShell — background service component.
//
// Drop once per app. No UI overlay. Responsibilities:
//   1. Poll the notifications table every 30 s.
//   2. On the first load of a browser session, when unread > 0 and the
//      user isn't already viewing notifications, open them — either via
//      the in-app `onOpen` callback (preferred) or a full-page redirect
//      to `notificationsUrl`. Fires once per session (sessionStorage
//      keyed by `sessionKey`) so that clicking a notification doesn't
//      bounce the user back to the inbox in a loop.
//   3. Show a "🔔 New notification · View / Close" toast when a new
//      notification arrives while the user is in the app and not on
//      the notifications view.
//
// The bell / counter / list UI live in NotificationsPage — the shell
// never renders one itself.

import { useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NotificationRow } from "./types";
import { eventMatchesApp, type AppKey } from "./notificationApps";

interface Props {
  kind: "vendor" | "internal";
  supabase: SupabaseClient;
  userId: string | null;
  /** URL of the dedicated notifications page, e.g. "/vendor/notifications"
   *  or "/notifications?from=tanda". Used by the full-redirect fallback
   *  when `onOpen` isn't provided. */
  notificationsUrl: string;
  /** Current path — used to suppress toast + auto-open while the user
   *  is already viewing the notifications page. Query strings in
   *  `notificationsUrl` are ignored for this match. */
  currentPath?: string;
  /** Optional flag for in-app views: true when the host app has
   *  switched to its in-app notifications view (no URL change). */
  isViewingNotifications?: boolean;
  /** sessionStorage key used to remember that auto-open already fired
   *  this browser session. */
  sessionKey?: string;
  /** If provided, called to open notifications in-app instead of doing
   *  a full-page redirect to `notificationsUrl`. Used for both the
   *  once-per-session auto-open and the toast "View" button. */
  onOpen?: () => void;
  /** When false, the shell does NOT auto-open notifications on first
   *  mount — the host app is responsible for handling that itself.
   *  The new-arrival toast still fires. Defaults to true. */
  autoOpen?: boolean;
  /** When set, the shell only counts/toasts notifications whose
   *  event_type is associated with this app. */
  appFilter?: AppKey;
}

const DEFAULT_SESSION_KEY = "rof_notifications_auto_open_dismissed";

export default function NotificationsShell({
  kind, supabase, userId, notificationsUrl, currentPath, isViewingNotifications,
  sessionKey = DEFAULT_SESSION_KEY, onOpen, autoOpen = true, appFilter,
}: Props) {
  const [toast, setToast] = useState<NotificationRow | null>(null);
  const lastSeenCreatedAt = useRef<string | null>(null);
  const autoOpenedThisMount = useRef(false);

  const recipientColumn = kind === "vendor" ? "recipient_auth_id" : "recipient_internal_id";
  const notifUrlPath = notificationsUrl.split("?")[0];
  const onNotificationsPage =
    isViewingNotifications ||
    (!!currentPath && (
      currentPath === notifUrlPath ||
      currentPath.startsWith(notifUrlPath + "/") ||
      currentPath.startsWith(notifUrlPath + "?")
    ));

  const openNotifications = () => {
    try { sessionStorage.setItem(sessionKey, "1"); } catch { /* noop */ }
    if (onOpen) onOpen();
    else window.location.href = notificationsUrl;
  };

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
      const all = (data ?? []) as NotificationRow[];
      const list = appFilter ? all.filter((n) => eventMatchesApp(n.event_type, appFilter)) : all;

      // New-arrival toast — anything unread AND newer than the last
      // created_at we've observed since mount.
      const prev = lastSeenCreatedAt.current;
      if (prev) {
        const newer = list.filter((n) => n.created_at > prev && !n.read_at);
        if (newer.length > 0 && !onNotificationsPage) setToast(newer[0]);
      }
      if (list.length > 0) lastSeenCreatedAt.current = list[0].created_at;

      // One-shot-per-session auto-open to notifications when unread > 0.
      // The sessionStorage guard prevents a redirect loop: after the user
      // clicks an item and navigates to its target, the shell on the new
      // page sees the flag is set and leaves them there. Skipped entirely
      // when `autoOpen` is false (host app manages this itself).
      if (autoOpen && !autoOpenedThisMount.current) {
        autoOpenedThisMount.current = true;
        let dismissed = false;
        try { dismissed = sessionStorage.getItem(sessionKey) === "1"; } catch { /* noop */ }
        const unread = list.filter((n) => !n.read_at).length;
        if (unread > 0 && !dismissed && !onNotificationsPage) {
          openNotifications();
        }
      }
    }
    void load();
    const i = window.setInterval(load, 30_000);
    return () => { cancelled = true; window.clearInterval(i); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, kind, notificationsUrl]);

  if (!userId || !toast || onNotificationsPage) return null;

  return <NewNotificationToast notification={toast} onView={openNotifications} onClose={() => setToast(null)} />;
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
