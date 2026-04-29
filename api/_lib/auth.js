// api/_lib/auth.js
//
// Tiny shared auth helper for Vercel serverless handlers. Validates a
// Supabase JWT from the Authorization header and (optionally) resolves
// the caller to a vendor_users / users row.
//
// The pattern was duplicated across searates-proxy and a couple of
// other handlers; this file consolidates it so new handlers (e.g.
// dropbox-proxy lockdown) can opt in with one line.
//
// Usage:
//   const auth = await authenticateCaller(req, admin);
//   if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
//   // auth.authId is now safe to use; never trust caller-supplied ids.
//
// Path prefixed with _ so Vercel does not treat it as a function.

export async function authenticateCaller(req, admin) {
  const header = req.headers?.authorization || "";
  const jwt = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!jwt) {
    return { ok: false, status: 401, error: "Missing bearer token", authId: null };
  }
  let authId = null;
  try {
    const { data } = await admin.auth.getUser(jwt);
    authId = data?.user?.id ?? null;
  } catch {
    authId = null;
  }
  if (!authId) {
    return { ok: false, status: 401, error: "Invalid or expired token", authId: null };
  }
  return { ok: true, status: 200, error: null, authId };
}

// Resolve auth_id → vendor_users.{id, vendor_id}. Returns 403 when the
// authenticated user isn't a vendor user (e.g. internal staff).
export async function resolveVendorUser(admin, authId) {
  const { data, error } = await admin
    .from("vendor_users")
    .select("id, vendor_id, status")
    .eq("auth_id", authId)
    .maybeSingle();
  if (error) {
    return { ok: false, status: 500, error: `vendor_users lookup failed: ${error.message}`, vendorUser: null };
  }
  if (!data) {
    return { ok: false, status: 403, error: "Caller is not a vendor user", vendorUser: null };
  }
  if (data.status && data.status !== "active") {
    return { ok: false, status: 403, error: `Vendor user status is "${data.status}" — access denied`, vendorUser: null };
  }
  return { ok: true, status: 200, error: null, vendorUser: data };
}

// Reject path inputs that try to escape a vendor's allowed root or
// otherwise smuggle directives into Dropbox / S3 path parameters.
// Use for caller-supplied path strings that are forwarded to a
// 3rd-party storage API.
export function isSafeDropboxPath(p) {
  if (!p || typeof p !== "string") return false;
  if (p.length > 1024) return false;
  if (p.includes("..")) return false;
  if (!/^\//.test(p)) return false;
  if (/[\x00-\x1f]/.test(p)) return false; // control chars
  return true;
}
