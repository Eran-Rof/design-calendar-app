// Wrapper that mounts NotificationsShell for any internal-app route
// that doesn't manage its own auth state.

import { useEffect, useState, type ReactNode } from "react";
import NotificationsShell from "./NotificationsShell";
import { supabaseClient } from "../../utils/supabase";

function readPlmUserId(): string | null {
  try {
    const raw = sessionStorage.getItem("plm_user");
    if (!raw) return null;
    return (JSON.parse(raw) as { id?: string }).id || null;
  } catch { return null; }
}

export default function WithNotifications({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<string | null>(() => readPlmUserId());
  useEffect(() => {
    if (userId) return;
    const i = window.setInterval(() => {
      const next = readPlmUserId();
      if (next) { setUserId(next); window.clearInterval(i); }
    }, 1000);
    return () => window.clearInterval(i);
  }, [userId]);

  return (
    <>
      {children}
      {supabaseClient && userId && (
        <NotificationsShell
          kind="internal"
          supabase={supabaseClient}
          userId={userId}
          notificationsUrl="/notifications"
          currentPath={typeof window !== "undefined" ? window.location.pathname : undefined}
          sessionKey="rof_notif_dismissed_internal"
        />
      )}
    </>
  );
}
