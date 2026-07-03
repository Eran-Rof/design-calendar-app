import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { TH } from "./theme";
import { supabaseVendor } from "./supabaseVendor";
import { notificationLink } from "../components/notifications/notificationLink";

interface Notification {
  id: string;
  event_type: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function NotificationBell() {
  const nav = useNavigate();
  const [items, setItems] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  async function load() {
    setLoading(true);
    try {
      const { data, error } = await supabaseVendor
        .from("notifications")
        .select("id, event_type, title, body, link, read_at, created_at, metadata")
        .order("created_at", { ascending: false })
        .limit(20);
      if (!error) setItems((data ?? []) as Notification[]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const interval = window.setInterval(load, 60_000); // poll every 60s
    return () => window.clearInterval(interval);
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  async function markRead(id: string) {
    await supabaseVendor.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", id);
    setItems((xs) => xs.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n)));
  }

  async function markAllRead() {
    const now = new Date().toISOString();
    const unread = items.filter((n) => !n.read_at).map((n) => n.id);
    if (unread.length === 0) return;
    await supabaseVendor.from("notifications").update({ read_at: now }).in("id", unread);
    setItems((xs) => xs.map((n) => (n.read_at ? n : { ...n, read_at: now })));
  }

  // Delete a single notification (RLS: vendor_own_notifications_delete). Optimistic;
  // reload on error so the list stays in sync.
  async function deleteOne(id: string) {
    setItems((xs) => xs.filter((n) => n.id !== id));
    const { error } = await supabaseVendor.from("notifications").delete().eq("id", id);
    if (error) void load();
  }

  async function onItemClick(n: Notification) {
    if (!n.read_at) await markRead(n.id);
    // Resolve to the actual record (PO/RFQ/invoice/dispute/…) via the shared
    // resolver so rows with only metadata (no explicit link) still navigate.
    const target = notificationLink(n, "vendor");
    if (target) {
      setOpen(false);
      nav(target);
    }
  }

  const unreadCount = items.filter((n) => !n.read_at).length;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          position: "relative",
          padding: "6px 10px",
          borderRadius: 6,
          border: "1px solid rgba(255,255,255,0.4)",
          background: "rgba(255,255,255,0.12)",
          color: "#FFFFFF",
          cursor: "pointer",
          fontSize: 16,
          fontFamily: "inherit",
          lineHeight: 1,
        }}
        aria-label="Notifications"
        title="Notifications"
      >
        Alerts
        {unreadCount > 0 && (
          <span style={{ position: "absolute", top: -4, right: -4, minWidth: 18, height: 18, padding: "0 4px", borderRadius: 999, background: TH.primary, color: "#FFF", fontSize: 10, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 8px)", right: 0, width: "min(380px, 95vw)", maxHeight: "min(480px, 90vh)", boxSizing: "border-box", background: TH.surface, color: TH.text, border: `1px solid ${TH.border}`, borderRadius: 10, boxShadow: `0 10px 25px ${TH.shadowMd}`, zIndex: 1000, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderBottom: `1px solid ${TH.border}`, background: TH.surfaceHi }}>
            <strong style={{ fontSize: 14, color: TH.text }}>Notifications</strong>
            {unreadCount > 0 && (
              <button onClick={markAllRead} style={{ fontSize: 12, color: TH.primary, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: 0 }}>
                Mark all read
              </button>
            )}
          </div>
          <div style={{ overflow: "auto", flex: 1 }}>
            {loading && items.length === 0 ? (
              <div style={{ padding: 20, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>Loading…</div>
            ) : items.length === 0 ? (
              <div style={{ padding: 30, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No notifications yet.</div>
            ) : (
              items.map((n) => (
                <div
                  key={n.id}
                  onClick={() => onItemClick(n)}
                  style={{
                    padding: "12px 14px",
                    borderBottom: `1px solid ${TH.border}`,
                    cursor: notificationLink(n, "vendor") ? "pointer" : "default",
                    background: n.read_at ? TH.surface : TH.surfaceHi,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 4 }}>
                    <strong style={{ fontSize: 13, color: TH.text }}>{n.title}</strong>
                    <span style={{ display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>
                      <span style={{ fontSize: 11, color: TH.textMuted }}>{timeAgo(n.created_at)}</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); void deleteOne(n.id); }}
                        title="Delete this notification"
                        style={{ background: "none", border: "none", color: TH.textMuted, cursor: "pointer", fontSize: 12, padding: 0, lineHeight: 1 }}
                      >Delete</button>
                    </span>
                  </div>
                  {n.body && <div style={{ fontSize: 12, color: TH.textSub2, lineHeight: 1.4 }}>{n.body}</div>}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
