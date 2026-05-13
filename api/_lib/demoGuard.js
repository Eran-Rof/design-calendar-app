// api/_lib/demoGuard.js
//
// Demo-mode short-circuit for external-integration proxies.
//
// When DEMO_MODE=true is set on the Vercel project, the four external
// proxies (xoro-proxy, searates-proxy, send-notification, vendor-invite)
// call demoEarlyExit() at the top of their handler. If demo mode is on,
// it writes a plausible canned response and returns true — caller returns
// immediately. If demo mode is off, it returns false and the handler
// runs normally with real credentials.
//
// Canned responses are intentionally minimal but shaped like real ones,
// so the app's success paths trigger without surprising the user with
// errors. Anything that would have side-effects on real systems (email
// send, Xoro writeback, Supabase Auth invite) is suppressed.

export function isDemoMode() {
  const v = (process.env.DEMO_MODE || "").trim().toLowerCase();
  return v === "true" || v === "1";
}

// Path-pattern based stub matcher. Called from api/dispatch.js BEFORE
// any handler runs, so it catches every sync/proxy route in one place.
// Returns the canned-response kind to use, or null if the path should
// flow through to the real handler.
//
// Anything that contacts Xoro, Searates, Resend, or Supabase Auth-admin
// goes here. Keep this list tight — accidentally stubbing a Supabase REST
// passthrough would break read/write paths the app actually needs.
export function demoStubKind(pathname) {
  // External proxies
  if (pathname === "/api/xoro-proxy")        return "xoro";
  if (pathname === "/api/searates-proxy")    return "searates";
  if (pathname === "/api/send-notification") return "notification";
  if (pathname === "/api/vendor-invite")     return "vendor-invite";
  // Xoro pull/push handlers (anything that calls out to Xoro)
  if (pathname.startsWith("/api/tanda-pos-sync"))           return "xoro";
  if (pathname.startsWith("/api/tanda/sync-from-xoro"))     return "xoro";
  if (pathname.startsWith("/api/xoro-ap-sync"))             return "xoro";
  if (pathname.startsWith("/api/xoro-items-missing-sync"))  return "xoro";
  if (pathname.startsWith("/api/xoro-receipts-sync"))       return "xoro";
  if (pathname.startsWith("/api/xoro-sales-sync"))          return "xoro";
  if (pathname.startsWith("/api/ats-supply-sync"))          return "xoro";
  if (pathname.startsWith("/api/planning/sync-"))           return "xoro";
  if (pathname.startsWith("/api/xoro/writeback"))           return "xoro-writeback";
  return null;
}

const CORS = (res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
};

// Returns true if the request was handled (caller should return immediately).
// `kind` selects the canned response shape: xoro | searates | notification |
// vendor-invite | xoro-writeback.
export function demoEarlyExit(req, res, kind) {
  if (!isDemoMode()) return false;
  CORS(res);
  if (req.method === "OPTIONS") { res.status(200).end(); return true; }

  const demoId = "demo-" + Math.random().toString(36).slice(2, 10);

  switch (kind) {
    case "xoro": {
      // Most Xoro endpoints return { Result, Data, TotalPages }. An empty
      // success keeps the app's sync flows happy ("no new rows from Xoro").
      res.status(200).json({
        Result: true,
        Data: [],
        TotalPages: 1,
        _demo: true,
        _message: "Demo mode: Xoro proxy returning empty success.",
      });
      return true;
    }
    case "searates": {
      res.status(200).json({
        ok: true,
        _demo: true,
        shipment: {
          tracking_id: demoId,
          status: "in_transit",
          last_event: "Vessel departed origin port (demo)",
          eta: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
        },
        events: [],
        quota_remaining: 999,
      });
      return true;
    }
    case "notification": {
      res.status(200).json({
        ok: true,
        _demo: true,
        id: demoId,
        email_delivered: false,
        push_delivered: false,
        note: "Demo mode: no email or push actually sent.",
      });
      return true;
    }
    case "vendor-invite": {
      res.status(200).json({
        ok: true,
        _demo: true,
        invited: true,
        note: "Demo mode: no Supabase Auth invite actually issued.",
      });
      return true;
    }
    case "xoro-writeback": {
      res.status(200).json({
        ok: true,
        _demo: true,
        dryRun: true,
        note: "Demo mode: writeback to Xoro suppressed.",
      });
      return true;
    }
    default: {
      res.status(200).json({ ok: true, _demo: true });
      return true;
    }
  }
}
