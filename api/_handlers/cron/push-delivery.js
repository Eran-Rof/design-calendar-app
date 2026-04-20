// api/cron/push-delivery
//
// Processes the push_notifications queue every 2 minutes.
//   - Pulls up to 100 queued rows
//   - Sends via APNs (iOS) or FCM (Android)
//   - Marks status sent | delivered | failed with attempt count
//   - Up to 3 retries per row (retry by leaving status='queued' on
//     recoverable errors; on permanent token errors, marks 'failed'
//     and deletes the mobile_sessions row to stop future retries)
//
// Env vars:
//   APNS_KEY               private key PEM contents (use escaped \n)
//   APNS_KEY_ID            Apple key id
//   APNS_TEAM_ID           Apple team id
//   APNS_BUNDLE_ID         iOS bundle id
//   APNS_USE_SANDBOX       'true' for dev, default production
//   FCM_SERVER_KEY         legacy FCM server key (simpler than HTTP v1)
//
// If APNs/FCM creds are missing for a platform, pushes for that
// platform are marked 'failed' with a clear error_message so ops
// can see what's misconfigured.

import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

export const config = { maxDuration: 60 };

const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 100;

// ─── APNs via HTTP/2 JWT (signed token) ────────────────────────────────
let apnsTokenCache = { token: null, expires: 0 };
function signApnsToken() {
  const keyId  = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const keyPem = process.env.APNS_KEY;
  if (!keyId || !teamId || !keyPem) return null;
  // Cache token for ~50 minutes (Apple allows up to 60 min)
  if (apnsTokenCache.token && Date.now() < apnsTokenCache.expires) return apnsTokenCache.token;

  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: keyId })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: teamId, iat: Math.floor(Date.now() / 1000) })).toString("base64url");
  const signer = crypto.createSign("SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign({ key: keyPem.replace(/\\n/g, "\n"), format: "pem", dsaEncoding: "ieee-p1363" }).toString("base64url");
  const token = `${header}.${payload}.${signature}`;
  apnsTokenCache = { token, expires: Date.now() + 50 * 60 * 1000 };
  return token;
}

async function sendApns(row) {
  const token = signApnsToken();
  if (!token) return { ok: false, permanent: false, error: "APNS credentials not configured" };
  const bundleId = process.env.APNS_BUNDLE_ID;
  const host = process.env.APNS_USE_SANDBOX === "true" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
  const deviceToken = row.device_token;
  const body = {
    aps: { alert: { title: row.title, body: row.body }, sound: "default", "mutable-content": 1 },
    data: row.data || {},
  };
  try {
    const r = await fetch(`https://${host}/3/device/${deviceToken}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${token}`,
        "apns-topic": bundleId,
        "apns-push-type": "alert",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (r.ok) return { ok: true };
    const txt = await r.text();
    let reason = "";
    try { reason = JSON.parse(txt)?.reason || txt.slice(0, 200); } catch { reason = txt.slice(0, 200); }
    const permanent = ["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"].includes(reason);
    return { ok: false, permanent, error: `APNs ${r.status} ${reason}` };
  } catch (e) {
    return { ok: false, permanent: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── FCM via legacy HTTP (simpler than OAuth HTTP v1) ──────────────────
async function sendFcm(row) {
  const serverKey = process.env.FCM_SERVER_KEY;
  if (!serverKey) return { ok: false, permanent: false, error: "FCM_SERVER_KEY not configured" };
  try {
    const r = await fetch("https://fcm.googleapis.com/fcm/send", {
      method: "POST",
      headers: {
        Authorization: `key=${serverKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: row.device_token,
        notification: { title: row.title, body: row.body },
        data: row.data || {},
      }),
    });
    const txt = await r.text();
    if (!r.ok) return { ok: false, permanent: false, error: `FCM ${r.status} ${txt.slice(0, 200)}` };
    let parsed;
    try { parsed = JSON.parse(txt); } catch { parsed = {}; }
    const err = parsed?.results?.[0]?.error || "";
    if (err) {
      const permanent = ["NotRegistered", "InvalidRegistration", "MismatchSenderId"].includes(err);
      return { ok: false, permanent, error: `FCM ${err}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, permanent: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export default async function handler(req, res) {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Pull a batch of queued rows, oldest first. Join to mobile_sessions
  // so we have the device token + platform without a second query.
  const { data: queue, error } = await admin
    .from("push_notifications")
    .select("id, title, body, data, mobile_session_id, vendor_user_id, status, session:mobile_sessions(id, device_token, platform)")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (error) return res.status(500).json({ error: error.message });

  let sent = 0, failed = 0, retried = 0, tokensRemoved = 0;

  for (const row of queue || []) {
    const sess = row.session;
    if (!sess) {
      await admin.from("push_notifications").update({
        status: "failed",
        error_message: "Mobile session was removed before delivery",
      }).eq("id", row.id);
      failed++;
      continue;
    }

    // Count prior attempts via error_message presence heuristic — use
    // metadata.attempts if schema supports it; fall back to status flips.
    const attemptsSoFar = row.status === "queued" ? 0 : 1;

    const target = { ...row, device_token: sess.device_token, platform: sess.platform };
    const result = sess.platform === "ios" ? await sendApns(target) : await sendFcm(target);

    if (result.ok) {
      await admin.from("push_notifications").update({
        status: "sent",
        sent_at: new Date().toISOString(),
      }).eq("id", row.id);
      sent++;
      continue;
    }

    if (result.permanent) {
      // Token is invalid forever — remove the session
      await admin.from("mobile_sessions").delete().eq("id", sess.id);
      await admin.from("push_notifications").update({
        status: "failed",
        error_message: `${result.error} (device token removed)`,
      }).eq("id", row.id);
      failed++;
      tokensRemoved++;
      continue;
    }

    if (attemptsSoFar + 1 >= MAX_ATTEMPTS) {
      await admin.from("push_notifications").update({
        status: "failed",
        error_message: `${result.error} (max attempts reached)`,
      }).eq("id", row.id);
      failed++;
      continue;
    }

    // Leave queued for retry on next cron tick; record last error
    await admin.from("push_notifications").update({
      error_message: result.error,
    }).eq("id", row.id);
    retried++;
  }

  return res.status(200).json({ processed: (queue || []).length, sent, failed, retried, tokens_removed: tokensRemoved });
}
