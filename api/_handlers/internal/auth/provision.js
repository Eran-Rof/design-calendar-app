// api/internal/auth/provision
//
// Tangerine — MS OAuth → Supabase Auth bridge.
//
// First-time-sign-in auto-provisioning so the operator no longer has to:
//   1. Open Supabase dashboard → Auth → Add user (paste email)
//   2. Open SQL editor → INSERT INTO entity_users (auth_id, entity_id, 'admin')
//   3. UPDATE employees SET auth_user_id = ... WHERE code = 'EB001'
//
// Flow:
//   POST /api/internal/auth/provision  {ms_access_token}
//   ── server validates token via Graph /me (re-fetched, NEVER trust client)
//   ── extracts email + ms_oid from Graph response
//   ── auth.users: lookup by email; create if missing (admin.createUser)
//   ── entity_users: upsert (auth_id, entity_id='ROF', role='admin')
//   ── employees: if code='EB001' has NULL auth_user_id, link it
//   ── returns {auth_user_id, email, entity_id, role, is_new_user}
//
// Security: the ONLY trust anchor is "did Graph honor this token?" — if Graph
// returns 401 we reject. We do not parse the JWT client-side, we do not trust
// any claim the client sends.
//
// Idempotent: ON CONFLICT (auth_id, entity_id) DO NOTHING on entity_users;
// employees link only happens when auth_user_id IS NULL. Calling this on
// every login is safe.

import { createClient } from "@supabase/supabase-js";
import { signAppJwt } from "../../../_lib/auth/appJwt.js";

export const config = { maxDuration: 15 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

const GRAPH_ME_URL = "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName";

// Exported so tests can swap in a fake fetcher without monkey-patching globalThis.
export async function validateMsTokenViaGraph(token, fetchImpl = globalThis.fetch) {
  if (!token || typeof token !== "string" || !token.trim()) {
    return { ok: false, status: 400, error: "ms_access_token required" };
  }
  let res;
  try {
    res = await fetchImpl(GRAPH_ME_URL, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    return { ok: false, status: 502, error: `Graph fetch failed: ${err.message || err}` };
  }
  if (!res.ok) {
    return { ok: false, status: 401, error: `Graph rejected token (HTTP ${res.status})` };
  }
  let me;
  try { me = await res.json(); }
  catch (_) { return { ok: false, status: 502, error: "Graph returned non-JSON" }; }

  const email = (me.mail || me.userPrincipalName || "").trim().toLowerCase();
  if (!email) {
    return { ok: false, status: 400, error: "Graph response missing email (mail/userPrincipalName both empty)" };
  }
  return {
    ok: true,
    profile: {
      email,
      ms_oid: me.id || null,
      display_name: me.displayName || null,
    },
  };
}

async function resolveRofEntityId(admin) {
  const { data, error } = await admin
    .from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (error || !data) return null;
  return data.id;
}

// Look up an existing auth user by email. Supabase's admin API does not expose
// a "get by email" so we paginate listUsers and filter.
//
// P27 — this MUST scan ALL users, not just the first page. When Tangerine becomes
// the suite-wide SSO gateway the user count grows past 100; a returning user whose
// auth.users row sits on page 2+ would otherwise be missed → provision would CREATE
// A SECOND auth.users row for the same email → a duplicate identity that splits
// their favorites / RBAC grants / audit history (all keyed by auth.users.id). The
// loop guarantees one email ⇒ one stable id at any scale.
async function findAuthUserByEmail(admin, email) {
  const target = email.trim().toLowerCase();
  const perPage = 200;
  const MAX_PAGES = 100; // backstop: 20k users — far beyond any real staff list
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ perPage, page });
    if (error) return { error };
    const users = data?.users || [];
    const user = users.find((u) => (u.email || "").toLowerCase() === target);
    if (user) return { user };
    // Last page reached (fewer than a full page returned) — stop.
    if (users.length < perPage) break;
  }
  return { user: null };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured (VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing)" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const ms_access_token = body?.ms_access_token;

  // 1. Security gate — re-validate the token against Graph server-side.
  const validation = await validateMsTokenViaGraph(ms_access_token);
  if (!validation.ok) {
    return res.status(validation.status || 401).json({ error: validation.error });
  }
  const { email, ms_oid, display_name } = validation.profile;

  // 2. Resolve ROF entity.
  const entity_id = await resolveRofEntityId(admin);
  if (!entity_id) {
    return res.status(500).json({ error: "Default entity (ROF) not found" });
  }

  // 3. Look up or create the auth.users row.
  const lookup = await findAuthUserByEmail(admin, email);
  if (lookup.error) {
    return res.status(500).json({ error: `auth listUsers failed: ${lookup.error.message || lookup.error}` });
  }

  let auth_user_id;
  let is_new_user = false;
  if (lookup.user) {
    auth_user_id = lookup.user.id;
  } else {
    const created = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      app_metadata: ms_oid ? { ms_oid, provider: "microsoft" } : { provider: "microsoft" },
      user_metadata: display_name ? { display_name } : {},
    });
    if (created.error || !created.data?.user?.id) {
      return res.status(500).json({ error: `auth.admin.createUser failed: ${created.error?.message || "no user returned"}` });
    }
    auth_user_id = created.data.user.id;
    is_new_user = true;
  }

  // 4. Upsert into entity_users with ON CONFLICT (auth_id, entity_id) DO NOTHING.
  // The unique constraint `entity_users_auth_entity_unique` makes this idempotent.
  const { error: euErr } = await admin
    .from("entity_users")
    .upsert(
      { auth_id: auth_user_id, entity_id, role: "admin" },
      { onConflict: "auth_id,entity_id", ignoreDuplicates: true }
    );
  if (euErr) {
    return res.status(500).json({ error: `entity_users upsert failed: ${euErr.message}` });
  }

  // 5. Link the EB001 employee row if it exists and is still unlinked.
  // Note: a future enhancement could match by email; for now the CEO seed is
  // hard-keyed to code='EB001' per migration 20260527010000_p2_employees.sql.
  const { data: emp, error: empSelErr } = await admin
    .from("employees")
    .select("id, auth_user_id")
    .eq("entity_id", entity_id)
    .eq("code", "EB001")
    .maybeSingle();
  if (empSelErr) {
    // Non-fatal — surface a warning but don't fail the whole provision call.
    console.warn("[auth/provision] employees lookup failed:", empSelErr.message);
  } else if (emp && !emp.auth_user_id) {
    const { error: empUpdErr } = await admin
      .from("employees")
      .update({ auth_user_id })
      .eq("id", emp.id);
    if (empUpdErr) console.warn("[auth/provision] employees link failed:", empUpdErr.message);
  }

  // 6. P14 JWT phase — mint a per-user access token so the browser can prove
  // WHO it is on every /api/internal call (enabling real RBAC enforcement +
  // per-user personalization). No-op until SUPABASE_JWT_SECRET is set on the
  // server: signAppJwt returns null, the client gets no token, and everything
  // behaves exactly as the cached-auth_user_id stopgap does today.
  const minted = signAppJwt(auth_user_id, { email });

  // P27 4b — also deliver the JWT as an httpOnly cookie (not readable by JS, so
  // XSS can't lift it). authenticateCaller accepts it OR the Authorization
  // header, so this is purely additive — the existing header path is untouched.
  // Same-site Lax + Secure + Path=/ so same-origin /api calls send it automatically.
  if (minted?.access_token) {
    res.setHeader("Set-Cookie",
      `tg_jwt=${encodeURIComponent(minted.access_token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${minted.expires_in}`);
  }

  return res.status(200).json({
    auth_user_id,
    email,
    entity_id,
    role: "admin",
    is_new_user,
    // Present only when JWT minting is enabled server-side.
    access_token: minted?.access_token ?? null,
    expires_in: minted?.expires_in ?? null,
  });
}
