# 25. Sign-in & Per-User Identity (the JWT bridge)

> **Status (2026-05-30):** the per-user token bridge is built and inert by default. It activates the moment `SUPABASE_JWT_SECRET` is set on the Vercel deployment. Until then, sign-in behaves exactly as before. This is the prerequisite that gives [RBAC enforcement](24-user-access-rbac.md) real teeth.

## Why this exists

You sign in with your Microsoft account. Behind the scenes the app provisions a matching user record (in `auth.users` + `entity_users`) so the server knows who you are. But until now the browser only held a *cached user id* — not a token the server could **verify**. That meant the RBAC layer couldn't truly trust "who is calling," so enforcement (`RBAC_MODE=enforce`) effectively passed everyone through.

The JWT bridge closes that gap: on sign-in, the server mints a short-lived, **signed** per-user token and hands it to your browser. Every internal API call then carries it, and the server cryptographically verifies it — so RBAC can finally enforce per-person, and your personalization (favorites, column prefs, default entity) becomes truly per-user instead of best-effort.

## How it works (plain English)

1. You sign in with Microsoft (unchanged).
2. The browser calls `/api/internal/auth/provision`, which **re-checks your Microsoft token with Microsoft** (never trusting the browser) and finds/creates your user record.
3. If the bridge is switched on, the server **signs a 12-hour access token** for you and returns it. Your browser caches it.
4. Every `/api/internal/**` request automatically attaches that token as `Authorization: Bearer …`. The server verifies the signature with the project's JWT secret and reads your identity from it — no extra round-trips.
5. Signing out (or 12 hours passing) drops the token; your next sign-in mints a fresh one.

The older shared "deploy token" still rides along on a separate header (`X-Internal-Token`) so the coarse "is this our frontend" gate keeps working unchanged.

## Turning it on

The bridge is a **no-op until you set one environment variable**. Build, deploy, and nothing changes — provisioning simply doesn't mint a token and the browser falls back to the old cached-id behavior. To activate:

1. In the **Supabase dashboard → Project Settings → API → JWT Settings**, copy the **JWT Secret**.
2. In **Vercel → the project → Settings → Environment Variables**, add:
   - **Name:** `SUPABASE_JWT_SECRET`
   - **Value:** *(the JWT secret from step 1)*
   - Scope: Production (and Preview if you test there).
3. Redeploy. From then on, every Microsoft sign-in mints a verifiable per-user token.

> Order of operations for RBAC go-live: **(a)** set `SUPABASE_JWT_SECRET` (this chapter) → **(b)** configure roles in 🔐 User Access → **(c)** `RBAC_MODE=log` and watch telemetry → **(d)** `RBAC_MODE=enforce`. Steps (a) and (b)/(c)/(d) are independent; (a) is what makes (d) actually bite.

## Security model

- The token is signed with the project's **JWT secret** — the same secret Supabase itself uses — so it's a first-class Supabase token (it would also satisfy database row-level security if we adopt per-user RLS later).
- It's only ever minted **after** the server re-validates your Microsoft token against Microsoft Graph. The browser can't talk the server into minting a token for someone else.
- The server **verifies the signature locally** on every request — a tampered or expired token is rejected. There's no way to hand-edit "who you are" into the token.
- The secret lives only in the server environment (never shipped to the browser). Rotating it in Supabase + Vercel invalidates outstanding tokens; everyone simply re-mints on next sign-in.

## What's NOT in scope yet

This bridge makes the **API layer** identity-aware. Making the **database itself** enforce per-user row access (per-user RLS, retiring the shared browser anon key) is a separate, larger security phase. The bridge is the foundation that phase builds on.

## Code map

- Token mint/verify: `api/_lib/auth/appJwt.js` (HMAC-SHA256; gated on `SUPABASE_JWT_SECRET`)
- Minted in: `api/_handlers/internal/auth/provision.js`
- Verified in: `api/_lib/auth.js` (`authenticateCaller` — local verify first, GoTrue fallback for vendor sessions)
- Browser plumbing: `src/utils/tangerineAuthUser.ts` (cache) + `src/utils/internalApiAuth.ts` (header injection) + `src/Tangerine.tsx` (provision wiring)
