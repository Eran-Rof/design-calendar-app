// Notify the Production Manager (in-app bell + email), best-effort.
//
// The PM is resolved data-first as the active employee titled "Production
// Manager" (resolveProductionManager), with an env/subscription fallback to the
// procurement recipients. Fires one /api/send-notification per resolved
// recipient. In-app delivery only reaches the bell when the employee is linked
// to a PLM login (employees.metadata.plm_user_id); otherwise the row is written
// under a sentinel internal_id and the recipient gets the EMAIL only.
//
// Never throws — a notification hiccup must not break the calling action.

import { resolveProductionManager } from "./internal-recipients.js";

export async function notifyProductionManager(admin, origin, msg = {}) {
  const out = { sent: false, resolved_via: "none", recipients: 0, in_app_delivered: 0, email_only: 0 };
  if (!admin || !origin) return out;
  try {
    const pm = await resolveProductionManager(admin, { event: msg.event_type || "production_manager_alert" });
    out.resolved_via = pm.resolved_via;
    if (!pm.employees || pm.employees.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(`[notify-pm] no Production Manager resolved for "${msg.event_type}". Tag an active employee with a "Production Manager" title, or set INTERNAL_PROCUREMENT_EMAILS.`);
      return out;
    }
    await Promise.all(pm.employees.map((recipient) => {
      const hasInAppTarget = typeof recipient.plm_user_id === "string" && recipient.plm_user_id;
      const internalId = hasInAppTarget ? recipient.plm_user_id : "production_manager";
      const targetApps = Array.isArray(recipient.apps) && recipient.apps.length > 0 ? recipient.apps : null;
      if (hasInAppTarget) out.in_app_delivered += 1; else out.email_only += 1;
      return fetch(`${origin}/api/send-notification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: msg.event_type || "production_manager_alert",
          title: msg.title || "Production Manager alert",
          body: msg.body || "",
          link: msg.link || null,
          metadata: { ...(msg.metadata || {}), ...(targetApps ? { target_apps: targetApps } : {}) },
          recipient: { internal_id: internalId, email: recipient.email },
          dedupe_key: msg.dedupe_key || undefined,
          email: msg.email !== false,
        }),
      }).catch(() => {});
    }));
    out.sent = true;
    out.recipients = pm.employees.length;
    if (out.email_only > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[notify-pm] ${out.email_only} Production Manager recipient(s) have no linked PLM login — EMAIL only, not the in-app bell. Link them in the Employees panel.`);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[notify-pm] notification issue for "${msg.event_type}": ${e && e.message ? e.message : String(e)}`);
  }
  return out;
}
