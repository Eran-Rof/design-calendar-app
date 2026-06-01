// api/_lib/b2b/session.js
//
// P18-B — B2B customer portal session resolver. THE single chokepoint that
// authenticates a buyer's browser session and scopes every portal API call to
// exactly one customer_id. C/D/E chunks (catalog / orders / account) MUST call
// resolveB2BSession() and use the returned customer_id — never a client-supplied
// one — so a buyer can never read or write another customer's data.
//
// Auth model:
//   The buyer signs in through Supabase Auth (passwordless magic link) in the
//   /b2b browser app. The browser holds a REAL GoTrue session and sends its
//   access token as `Authorization: Bearer <jwt>`. We verify that token by
//   asking Supabase to resolve it (admin.auth.getUser(token)) — the same proven
//   path the vendor portal uses (api/_lib/vendor-auth.js). We do NOT use the
//   staff MS-OAuth app-JWT (api/_lib/auth/appJwt.js): that verifies only tokens
//   WE minted (iss "tangerine-ms-bridge"), not real GoTrue buyer sessions.
//
// Authorization:
//   A verified auth.users identity is necessary but NOT sufficient. The buyer
//   must also have an ACTIVE row in b2b_accounts. We look up by auth_user_id
//   first; on first login we fall back to lower(email) and BIND auth_user_id +
//   stamp last_login_at. No active row → not authorized for the portal.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Extract the raw bearer token from the Authorization header. Returns null when
// absent or malformed.
export function extractBearer(req) {
  const h = req?.headers || {};
  const authHeader = h.authorization || h.Authorization;
  if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  return token.length > 0 ? token : null;
}

// Verify a Supabase access token and return the underlying auth.users identity
// { id, email } or null. NEVER throws.
async function verifyBuyerToken(admin, token) {
  try {
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data?.user?.id) return null;
    return { id: data.user.id, email: (data.user.email || "").trim().toLowerCase() || null };
  } catch {
    return null;
  }
}

/**
 * resolveB2BSession(req, admin)
 *
 * The portal auth+authorization chokepoint. Returns:
 *   { ok: true,  account, customer_id }
 *   { ok: false, status, error }
 *
 * `account` is the b2b_accounts row; `customer_id` is its (server-trusted)
 * customer_id — use THIS to scope every query. Side effect: on the first login
 * for an account matched by email, binds auth_user_id and stamps last_login_at.
 */
export async function resolveB2BSession(req, admin) {
  if (!admin) return { ok: false, status: 503, error: "Server not configured" };

  const token = extractBearer(req);
  if (!token) return { ok: false, status: 401, error: "Authentication required" };

  const ident = await verifyBuyerToken(admin, token);
  if (!ident) return { ok: false, status: 401, error: "Invalid or expired session" };

  const COLS = "id, entity_id, customer_id, email, auth_user_id, display_name, role, is_active, can_place_orders";

  // Primary lookup: already-bound auth_user_id.
  let account = null;
  if (UUID_RE.test(ident.id)) {
    const { data } = await admin
      .from("b2b_accounts")
      .select(COLS)
      .eq("auth_user_id", ident.id)
      .maybeSingle();
    account = data || null;
  }

  // First-login fallback: match by email (b2b_accounts has UNIQUE lower(email)),
  // then bind the auth_user_id so subsequent logins hit the primary path.
  if (!account && ident.email) {
    const { data } = await admin
      .from("b2b_accounts")
      .select(COLS)
      .ilike("email", ident.email)
      .maybeSingle();
    if (data) {
      account = data;
      // Bind identity on first successful login. Best-effort: only set
      // auth_user_id when it's not already bound to a DIFFERENT identity.
      if (!account.auth_user_id) {
        try {
          await admin
            .from("b2b_accounts")
            .update({ auth_user_id: ident.id })
            .eq("id", account.id)
            .is("auth_user_id", null);
          account.auth_user_id = ident.id;
        } catch { /* non-fatal */ }
      } else if (account.auth_user_id !== ident.id) {
        // Email matched a row already bound to someone else — refuse rather
        // than hijack the binding.
        return { ok: false, status: 403, error: "Not authorized for the portal" };
      }
    }
  }

  if (!account) return { ok: false, status: 403, error: "Not authorized for the portal" };
  if (account.is_active === false) return { ok: false, status: 403, error: "Your portal access is inactive" };
  if (!account.customer_id) return { ok: false, status: 403, error: "Portal account is not linked to a customer" };

  // Stamp last_login_at (fire-and-forget; never blocks the request).
  try {
    admin.from("b2b_accounts").update({ last_login_at: new Date().toISOString() }).eq("id", account.id).then(() => {}, () => {});
  } catch { /* swallow */ }

  return { ok: true, account, customer_id: account.customer_id };
}
