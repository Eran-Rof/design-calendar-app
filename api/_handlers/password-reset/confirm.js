// api/password-reset/confirm — POST { token, password }
//
// Completes a password reset / first-time set for either login type. Pairs with
// api/_handlers/password-reset/request.js, which mints a random token (sha256
// hash stored in password_reset_tokens, raw token emailed in the reset link).
//
// Here we:
//   1. Verify the token: exists, unused, unexpired.
//   2. Set the new password:
//        - 'plm'    → sha256 the password, update the user in app_data['users'].
//        - 'vendor' → admin.updateUserById(authId, { password, email_confirm }).
//   3. Mark the token used (single-use).
//
// Covers "account has a login but no password yet" automatically — the same set
// path runs whether or not a password existed before.
//
// Security: token hashed at rest, single-use + expiry enforced server-side,
// strict validation (unauthenticated by nature), no raw token/password logging,
// service-role only (bypasses RLS).

import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

export const config = { maxDuration: 15 };

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }

  const token = String(body?.token || "").trim();
  const password = String(body?.password || "");
  if (!token) return res.status(400).json({ error: "token is required" });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const tokenHash = sha256(token);

  // Atomically CLAIM the token: flip used_at NULL→now only if it's still unused
  // AND unexpired, in a single conditional UPDATE. This closes the TOCTOU window
  // a select-then-update would leave open (two concurrent requests with the same
  // token both passing the check). Fail-safe: the token is burned before the
  // password is set — if the set then fails, the user just requests a new link.
  const nowIso = new Date().toISOString();
  const { data: row, error: tErr } = await admin
    .from("password_reset_tokens")
    .update({ used_at: nowIso })
    .eq("token_hash", tokenHash)
    .is("used_at", null)
    .gt("expires_at", nowIso)
    .select("id, subject_type, subject_id, email")
    .maybeSingle();
  if (tErr) return res.status(500).json({ error: "Token lookup failed" });
  if (!row) {
    // Nothing claimed → never existed, already used, or expired. One generic
    // message (don't reveal which case it was).
    return res.status(400).json({ error: "This reset link is invalid, expired, or already used." });
  }

  try {
    if (row.subject_type === "vendor") {
      // Vendor: password lives in Supabase Auth. Set it + confirm email so they
      // can sign in immediately (also covers "no password yet").
      const { error: uErr } = await admin.auth.admin.updateUserById(row.subject_id, { password, email_confirm: true });
      if (uErr) return res.status(500).json({ error: "Could not set password." });
    } else {
      // PLM: password lives in app_data['users'] as an sha256 hash. Read, patch
      // the matching user, write back. Use a read-then-write guard so we never
      // clobber the whole blob with a partial/empty array.
      const { data: rows, error: rErr } = await admin.from("app_data").select("value").eq("key", "users").maybeSingle();
      if (rErr) return res.status(500).json({ error: "Could not load users." });
      let users = [];
      try { users = JSON.parse(rows?.value || "[]"); } catch { users = []; }
      if (!Array.isArray(users) || users.length === 0) {
        return res.status(500).json({ error: "User store unavailable. Try again." });
      }
      const idx = users.findIndex((u) => String(u?.id) === String(row.subject_id));
      if (idx === -1) {
        // The user was deleted after the token was minted. The token is already
        // burned (claimed above); just treat as an invalid link.
        return res.status(400).json({ error: "This reset link is no longer valid." });
      }
      const newHash = sha256(password);
      users[idx] = { ...users[idx], password: newHash };
      // Drop any legacy plaintext pin so it can't be used as an alternate
      // credential after a deliberate password reset.
      if ("pin" in users[idx]) delete users[idx].pin;
      const { error: wErr } = await admin
        .from("app_data")
        .upsert({ key: "users", value: JSON.stringify(users) }, { onConflict: "key" });
      if (wErr) return res.status(500).json({ error: "Could not save the new password." });
    }

    // This token was already burned by the atomic claim above. Also burn any
    // OTHER outstanding tokens for this subject so a second emailed link can't
    // be replayed.
    await admin
      .from("password_reset_tokens")
      .update({ used_at: nowIso })
      .eq("subject_type", row.subject_type)
      .eq("subject_id", row.subject_id)
      .is("used_at", null);

    return res.status(200).json({ ok: true, subject_type: row.subject_type, email: row.email });
  } catch {
    return res.status(500).json({ error: "Could not complete the password reset." });
  }
}
