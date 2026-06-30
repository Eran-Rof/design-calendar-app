# P27 — Suite SSO & Tangerine-as-Gateway Architecture

> Status: **DRAFT for CEO sign-off** (2026-06-30). Phase 1 (identity-bridge hardening)
> ships with this doc; later phases are flag-gated and listed here for direction.
> Goal: Tangerine becomes the suite **home + gateway**, behind **one Microsoft (Entra
> ID) identity** shared by every app — eliminating the dual-auth bug class.

---

## 1. Decision (CEO, 2026-06-30)
- **Single front door = Microsoft SSO for everyone** (Entra ID / M365).
- **Other apps already launch from Tangerine's drawer** ("Apps" menu) — no app-embedding
  refactor needed; they just need to inherit the shared session.
- Tangerine becomes the landing app at `/` (flag `VITE_TANGERINE_AS_HOME` already exists).

## 2. Why — the dual-identity bug class
Today two auth systems run in parallel and don't share a session:
- **PLM launcher** — username/password → `sessionStorage.plm_user` (today's gateway at `/`).
- **Tangerine** — MS OAuth → `localStorage.ms_tokens` + a **per-user app JWT** minted by
  `POST /api/internal/auth/provision` (`signAppJwt`, gated on `SUPABASE_JWT_SECRET`).

The "no-relogin" change ([project_app_no_relogin_g]) let Tangerine **adopt the PLM session**
without running MS-OAuth — so the per-user JWT is never minted on that path. Everything that
needs real per-user identity then breaks. Already hit and patched reactively:
- Favorites vanish + won't save (#1508) — `/users/me/preferences*` 401.
- Audit reads 401 (#1509).
- Sign-out just refreshed (#1511) — PLM session re-adopted on reload.

These are all the **same root cause**: no single identity. The gateway can't be best-in-class
on two identities. Unifying identity removes the class, not the instances.

## 3. Target architecture
1. **One IdP, one token.** Microsoft Entra ID is the only login. On return, `/auth/provision`
   validates the MS token via Graph, resolves a **stable `auth.users.id` by email**, and mints
   **one app JWT** (`tangerine.auth_jwt`) that the `internalApiAuth` fetch interceptor already
   attaches to every `/api/internal/**` call. All apps consume that one token.
2. **Tangerine is the shell.** Served at `/`; the PLM launcher cards become Tangerine's Apps
   drawer (already the case). Opening any app carries the shared JWT — true SSO, no re-login,
   done correctly (shared token, not session cloning).
3. **RBAC enforced.** P14 RBAC is built but dormant only because there was no per-user JWT.
   With unified SSO, flip `RBAC_MODE` to `enforce` (after a log-only warm-up): per-app /
   per-module / per-action, validated server-side — replacing today's client-only,
   default-true PLM perms.
4. **Session lifecycle.** Silent refresh (MSAL `acquireTokenSilent`) so nobody is kicked at
   the 12h JWT expiry; prefer an **httpOnly cookie** for the JWT (set by provision) over
   `localStorage`; **global sign-out + idle-logout** broadcast across tabs (the
   `plmSessionTabs` `BroadcastChannel` primitive already exists).
5. **API hardening.** `/api/internal/**` is currently fail-open on a static shared token.
   With per-user JWT everywhere, require it for **writes** (reads may keep the internal
   token), enforced by RBAC.

## 4. Identity mapping (the migration that must not lose data)
- **Favorites / RBAC grants / audit / personalization are keyed by `auth.users.id`.**
  Provision resolves that id **by email** (`findAuthUserByEmail`), so as long as a person's
  **M365 email == the email already on their `auth.users` row**, their data carries over with
  zero migration. This is the whole mapping — keep it email-stable.
- **Stability requirement (Phase 1, this PR):** `findAuthUserByEmail` must scan **all** users,
  not just the first 100, or a returning user past page 1 gets a **new** id → a duplicate
  identity → split favorites/RBAC. Fixed here by paginating the lookup.
- **Employee linking (later phase):** also link each `employees` row to its `auth_user_id` by
  email (today only the hard-keyed `EB001` seed is linked). Non-blocking; HR/Commissions nicety.
- **Prerequisite:** every internal user needs an M365 account whose email matches their
  existing record. Audit the staff list before flipping the front door (Phase 3).
- **Break-glass:** keep ONE admin local login path so an Entra outage can't lock the company
  out of its own ERP.

## 5. Phased rollout (live system — order minimizes risk)
- **Phase 1 (this PR) — identity-bridge foundation.** Paginate `findAuthUserByEmail` so one
  email ⇒ one stable `auth.users.id` at any scale. Verify `SUPABASE_JWT_SECRET` is set in all
  envs (without it no JWT is minted and unification is impossible). Pure hardening — **no login
  behavior change**, fully backward compatible.
- **Phase 2 — resilient per-user reads** (largely shipped): `resolveUserId()` /
  internal-token fallbacks already keep personalization + audit working during the
  transition ([feedback_personalization_jwt_fallback], #1509).
- **Phase 3 — front door = Microsoft** (flag-gated). **Mechanism SHIPPED, default OFF**
  (`VITE_SUITE_SSO_FRONT_DOOR`, env in `appConfig`): when ON, Tangerine no longer silently
  adopts the cloned PLM session — a tokenless user lands on the Microsoft login (which
  provisions identity by email + mints the JWT). The login screen shows a **"Continue with
  launcher session" break-glass** link when a PLM session exists, so an Entra outage can't
  lock anyone out. Flip ON in Vercel only once M365 coverage is confirmed 12/12. Pair with
  `VITE_TANGERINE_AS_HOME` to make `/` land on Tangerine.
- **Phase 4 — session lifecycle.** Silent refresh + httpOnly cookie + suite-wide global
  sign-out / idle-logout via the BroadcastChannel.
- **Phase 5 — RBAC `enforce`** (per app, log-only warm-up first) + API per-user write
  enforcement; retire `plm_user` and the static-token fail-open.

## 6. Risks / open decisions
- **M365 coverage** — every user must have a matching M365 account before Phase 3; otherwise
  they're locked out. Audit + provision-by-email guarantees data carry-over when emails match.
- **Entra outage** — mitigated by the break-glass admin login.
- **JWT in localStorage** — readable by app JS today; move to httpOnly cookie in Phase 4.
- **Email changes** — if a user's email changes in M365, provision would mint a new id and
  orphan their data. Handle via an explicit admin "merge identity" tool if it ever happens.
