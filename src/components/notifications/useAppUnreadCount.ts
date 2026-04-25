// Shared hook: returns the unread-notification count for the current
// user, filtered by the app's event_type allowlist. Used by every
// internal app's nav bell badge.
//
// Refreshes on:
//   - mount (and userId/app changes)
//   - 30s polling
//   - the `rof_notif_changed` window event (dispatched by
//     NotificationsPage after any mark-read action)

import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { eventMatchesApp, appAllowedEvents, type AppKey } from "./notificationApps";

interface Args {
  supabase: SupabaseClient | null | undefined;
  userId: string | null | undefined;
  recipientColumn: "recipient_internal_id" | "recipient_auth_id";
  app: AppKey;
}

export function useAppUnreadCount({ supabase, userId, recipientColumn, app }: Args): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!supabase || !userId) return;
    let cancelled = false;
    const allowed = appAllowedEvents(app);

    async function load() {
      if (!supabase || !userId) return;
      // When the app shows everything (allowed === null), use a head
      // count for cheapness. Otherwise fetch event_types and filter.
      if (allowed === null) {
        const { count: c } = await supabase
          .from("notifications")
          .select("*", { count: "exact", head: true })
          .eq(recipientColumn, userId)
          .is("read_at", null);
        if (!cancelled) setCount(c || 0);
        return;
      }
      const { data, error } = await supabase
        .from("notifications")
        .select("event_type")
        .eq(recipientColumn, userId)
        .is("read_at", null)
        .limit(500);
      if (cancelled || error) return;
      const filtered = (data || []).filter((n: { event_type: string }) => eventMatchesApp(n.event_type, app));
      setCount(filtered.length);
    }

    void load();
    const i = window.setInterval(load, 30_000);
    const onChanged = () => { void load(); };
    window.addEventListener("rof_notif_changed", onChanged);
    return () => {
      cancelled = true;
      window.clearInterval(i);
      window.removeEventListener("rof_notif_changed", onChanged);
    };
  }, [supabase, userId, recipientColumn, app]);

  return count;
}
