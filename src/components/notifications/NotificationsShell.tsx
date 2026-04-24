// NotificationsShell — drop this once per app, get:
//   • Fixed-position bell in the top-right with an unread counter
//   • Full-screen notifications "page" (modal) opened by the bell
//   • Auto-opens on mount if unread > 0 (once per browser session;
//     user dismiss is remembered in sessionStorage)
//   • Toast popup when a new notification arrives while the user is
//     active in the app — "New notification · View / Close"
//
// Works for both:
//   <NotificationsShell kind="vendor"   supabase={supabaseVendor}   userId={supabaseAuthUid} />
//   <NotificationsShell kind="internal" supabase={supabaseClient}   userId={internalUserId} />
//
// Filters notifications table by recipient_auth_id or recipient_internal_id
// accordingly.

import { useEffect, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface NotificationRow {
  id: string;
  event_type: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
  recipient_auth_id: string | null;
  recipient_internal_id: string | null;
  metadata: Record<string, unknown> | null;
}

interface Props {
  kind: "vendor" | "internal";
  supabase: SupabaseClient;
  userId: string | null;
  /** Optional override for the session-scoped "auto-open dismiss" key.
   *  Useful when two different apps might share a tab but want
   *  independent dismiss memory. Defaults to the global key. */
  sessionKey?: string;
}

// Neutral dark palette so the shell looks consistent in every app
// regardless of the host's theme.
const C = {
  bg: "#0F172A",
  surface: "#1E293B",
  surfaceHi: "#334155",
  border: "#475569",
  text: "#F1F5F9",
  textSub: "#CBD5E1",
  textMuted: "#94A3B8",
  primary: "#3B82F6",
  primaryLt: "#60A5FA",
  warn: "#F59E0B",
  danger: "#EF4444",
  success: "#10B981",
  unread: "#1E3A8A33",
};

const DEFAULT_SESSION_KEY = "rof_notifications_auto_open_dismissed";

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function NotificationsShell({ kind, supabase, userId, sessionKey = DEFAULT_SESSION_KEY }: Props) {
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<NotificationRow | null>(null);
  const [loading, setLoading] = useState(false);
  const lastSeenCreatedAt = useRef<string | null>(null);
  const autoOpenedThisMount = useRef(false);
  const openRef = useRef(open);
  useEffect(() => { openRef.current = open; }, [open]);

  const recipientColumn = kind === "vendor" ? "recipient_auth_id" : "recipient_internal_id";

  async function load() {
    if (!userId) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("notifications")
        .select("id, event_type, title, body, link, read_at, created_at, recipient_auth_id, recipient_internal_id, metadata")
        .eq(recipientColumn, userId)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) return;
      const list = (data ?? []) as NotificationRow[];

      // New-arrival detection (toast): anything newer than the last
      // we saw, and not already open, is toast-worthy.
      const prev = lastSeenCreatedAt.current;
      if (prev) {
        const newer = list.filter((n) => n.created_at > prev && !n.read_at);
        if (newer.length > 0 && !openRef.current) setToast(newer[0]);
      }
      if (list.length > 0) lastSeenCreatedAt.current = list[0].created_at;

      setItems(list);

      // Auto-open on first load of this mount if there are unread
      // notifications AND the user hasn't already dismissed this
      // session.
      if (!autoOpenedThisMount.current) {
        autoOpenedThisMount.current = true;
        const dismissed = sessionStorage.getItem(sessionKey) === "1";
        const unread = list.filter((n) => !n.read_at).length;
        if (unread > 0 && !dismissed) setOpen(true);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!userId) return;
    void load();
    const i = window.setInterval(load, 30_000);
    return () => window.clearInterval(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, kind]);

  function closeAndRemember() {
    setOpen(false);
    try { sessionStorage.setItem(sessionKey, "1"); } catch { /* noop */ }
  }

  async function markRead(id: string) {
    const { error } = await supabase.from("notifications")
      .update({ read_at: new Date().toISOString() }).eq("id", id);
    if (error) return;
    setItems((xs) => xs.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n)));
  }

  async function markAllRead() {
    const unread = items.filter((n) => !n.read_at).map((n) => n.id);
    if (unread.length === 0) return;
    const now = new Date().toISOString();
    const { error } = await supabase.from("notifications").update({ read_at: now }).in("id", unread);
    if (error) return;
    setItems((xs) => xs.map((n) => (n.read_at ? n : { ...n, read_at: now })));
  }

  function handleItemClick(n: NotificationRow) {
    if (!n.read_at) void markRead(n.id);
    if (n.link) {
      closeAndRemember();
      // Use hard navigation so the link works across any of our apps.
      window.location.href = n.link;
    }
  }

  const unreadCount = useMemo(() => items.filter((n) => !n.read_at).length, [items]);

  if (!userId) return null;

  return (
    <>
      {/* Fixed-position bell, top-right */}
      <div style={{ position: "fixed", top: 14, right: 18, zIndex: 9000 }}>
        <button
          onClick={() => { if (open) closeAndRemember(); else setOpen(true); }}
          aria-label="Notifications"
          title="Notifications"
          style={{
            position: "relative",
            padding: "8px 12px",
            borderRadius: 8,
            border: `1px solid ${unreadCount > 0 ? C.primary : C.border}`,
            background: unreadCount > 0 ? "#1E3A8A88" : "rgba(15,23,42,0.85)",
            color: "#FFFFFF",
            cursor: "pointer",
            fontSize: 16,
            fontFamily: "inherit",
            lineHeight: 1,
            boxShadow: "0 4px 12px rgba(0,0,0,0.35)",
            backdropFilter: "blur(6px)",
          }}
        >
          🔔
          {unreadCount > 0 && (
            <span style={{ position: "absolute", top: -6, right: -6, minWidth: 20, height: 20, padding: "0 5px", borderRadius: 999, background: C.danger, color: "#FFF", fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", border: `2px solid ${C.bg}` }}>
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </button>
      </div>

      {open && (
        <NotificationsCenter
          items={items}
          loading={loading}
          unreadCount={unreadCount}
          onClose={closeAndRemember}
          onItemClick={handleItemClick}
          onMarkAllRead={markAllRead}
          onMarkRead={markRead}
          onRefresh={load}
        />
      )}

      {toast && !open && (
        <NewNotificationToast
          notification={toast}
          onView={() => { setOpen(true); setToast(null); }}
          onClose={() => setToast(null)}
        />
      )}
    </>
  );
}

function NotificationsCenter({
  items, loading, unreadCount, onClose, onItemClick, onMarkAllRead, onMarkRead, onRefresh,
}: {
  items: NotificationRow[];
  loading: boolean;
  unreadCount: number;
  onClose: () => void;
  onItemClick: (n: NotificationRow) => void;
  onMarkAllRead: () => void;
  onMarkRead: (id: string) => void;
  onRefresh: () => void;
}) {
  const [filter, setFilter] = useState<"all" | "unread">(unreadCount > 0 ? "unread" : "all");
  const [search, setSearch] = useState("");

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((n) => {
      if (filter === "unread" && n.read_at) return false;
      if (!q) return true;
      return [n.title, n.body, n.event_type].filter(Boolean).join(" ").toLowerCase().includes(q);
    });
  }, [items, filter, search]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={(e) => { if (e.currentTarget === e.target) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 10000,
        background: "rgba(15, 23, 42, 0.72)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
      }}
    >
      <div style={{
        width: "min(780px, calc(100vw - 48px))",
        height: "min(720px, calc(100vh - 48px))",
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 14,
        boxShadow: "0 20px 60px rgba(0,0,0,0.55)",
        display: "flex", flexDirection: "column",
        overflow: "hidden",
        color: C.text,
      }}>
        <div style={{ padding: "14px 20px", background: C.surfaceHi, borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: C.text }}>Notifications</h2>
          <span style={{ fontSize: 12, color: C.textMuted }}>
            {unreadCount} unread · {items.length} total
          </span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              style={{
                padding: "6px 10px", borderRadius: 6,
                border: `1px solid ${C.border}`, background: C.bg, color: C.text,
                fontSize: 12, fontFamily: "inherit", width: 200,
              }}
            />
            {(["unread", "all"] as const).map((f) => (
              <button key={f} onClick={() => setFilter(f)}
                style={{
                  padding: "6px 12px", borderRadius: 6,
                  border: `1px solid ${filter === f ? C.primary : C.border}`,
                  background: filter === f ? C.primary : "transparent",
                  color: filter === f ? "#fff" : C.textSub,
                  cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit",
                  textTransform: "capitalize",
                }}>
                {f}{f === "unread" && unreadCount > 0 ? ` (${unreadCount})` : ""}
              </button>
            ))}
            <button onClick={onRefresh} title="Refresh" style={iconBtn}>↻</button>
            {unreadCount > 0 && (
              <button onClick={onMarkAllRead} style={{ ...iconBtn, color: C.primaryLt }}>Mark all read</button>
            )}
            <button onClick={onClose} aria-label="Close" style={iconBtn}>Close</button>
          </div>
        </div>

        <div style={{ flex: 1, overflow: "auto", background: C.bg }}>
          {loading && items.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: C.textMuted, fontSize: 13 }}>Loading…</div>
          ) : visible.length === 0 ? (
            <div style={{ padding: 60, textAlign: "center", color: C.textMuted, fontSize: 14 }}>
              {items.length === 0
                ? "No notifications yet. You're all caught up."
                : filter === "unread"
                  ? "No unread notifications."
                  : `No notifications match "${search.trim()}".`}
            </div>
          ) : (
            visible.map((n) => {
              const unread = !n.read_at;
              return (
                <div
                  key={n.id}
                  onClick={() => onItemClick(n)}
                  style={{
                    padding: "14px 20px",
                    borderBottom: `1px solid ${C.surfaceHi}`,
                    background: unread ? C.unread : "transparent",
                    cursor: n.link ? "pointer" : "default",
                    display: "grid", gridTemplateColumns: "1fr auto",
                    gap: 10,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      {unread && <span style={{ width: 8, height: 8, borderRadius: 999, background: C.primary, flexShrink: 0 }} />}
                      <strong style={{ fontSize: 14, color: C.text }}>{n.title}</strong>
                      <span style={{ fontSize: 10, color: C.textMuted, padding: "2px 8px", borderRadius: 10, background: C.surfaceHi, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>{n.event_type}</span>
                    </div>
                    {n.body && <div style={{ fontSize: 13, color: C.textSub, lineHeight: 1.45 }}>{n.body}</div>}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, fontSize: 11, color: C.textMuted, whiteSpace: "nowrap" }}>
                    <span>{timeAgo(n.created_at)}</span>
                    {unread && (
                      <button
                        onClick={(e) => { e.stopPropagation(); void onMarkRead(n.id); }}
                        style={{ ...iconBtn, fontSize: 11, padding: "2px 8px" }}
                      >Mark read</button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function NewNotificationToast({
  notification, onView, onClose,
}: {
  notification: NotificationRow;
  onView: () => void;
  onClose: () => void;
}) {
  // Auto-dismiss after 8 s. User can hit View or Close.
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
      background: C.surface,
      color: C.text,
      border: `1px solid ${C.primary}`,
      borderRadius: 10,
      boxShadow: "0 14px 40px rgba(0,0,0,0.55)",
      padding: "14px 16px",
      fontFamily: "system-ui, -apple-system, sans-serif",
      animation: "notif-slide-in 0.25s ease-out",
    }}>
      <div style={{ fontSize: 10, color: C.primaryLt, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
        🔔 New notification
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 2 }}>
        {notification.title}
      </div>
      {notification.body && (
        <div style={{ fontSize: 12, color: C.textSub, marginBottom: 10, lineHeight: 1.4 }}>
          {notification.body.length > 140 ? notification.body.slice(0, 140) + "…" : notification.body}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
        <button onClick={onClose} style={{ ...iconBtn, padding: "5px 12px", fontSize: 12 }}>Close</button>
        <button
          onClick={onView}
          style={{
            padding: "5px 14px", borderRadius: 6, border: "none",
            background: C.primary, color: "#fff", cursor: "pointer",
            fontSize: 12, fontWeight: 700, fontFamily: "inherit",
          }}
        >View</button>
      </div>
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  padding: "5px 10px", borderRadius: 5,
  border: `1px solid ${C.border}`, background: "transparent", color: C.textSub,
  cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit",
};
