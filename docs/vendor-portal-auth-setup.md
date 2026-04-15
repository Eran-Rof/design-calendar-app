# Vendor Portal — Supabase Auth Setup

The vendor portal uses Supabase Auth (separate from the internal custom auth
in `app_data['users']`). This doc lists the one-time dashboard configuration
steps required before Phase 1 can be exercised end-to-end.

Apply these in the Supabase project dashboard
(<https://supabase.com/dashboard>). Everything here is configuration — no code
changes are involved.

## 1. Enable email provider

Authentication → Providers → Email

- **Enable Email provider**: ON
- **Enable email confirmations**: ON
  (required — vendors are invited, not self-signup, and invite link doubles
  as the confirmation step)
- **Secure email change**: ON (default)
- **Allow new users to sign up**: OFF
  (vendors are admin-invited only via `api/vendor-invite.js`; no public signup)

## 2. URL configuration

Authentication → URL Configuration

- **Site URL**:
  - Dev: `http://localhost:5173`
  - Prod: `https://<your-vercel-domain>`
- **Redirect URLs** (add both):
  - `http://localhost:5173/vendor/setup`
  - `https://<your-vercel-domain>/vendor/setup`

The `/vendor/setup` route is where invited users land after clicking the
invite email; the page calls `supabase.auth.updateUser({ password })` to
finish their account.

## 3. Email templates

Authentication → Email Templates → **Invite user**

Subject:

    You've been invited to the Ring of Fire vendor portal

Body (HTML — replace the default):

    <h2>You've been invited</h2>
    <p>
      Click the link below to set your password and access your
      Ring of Fire vendor portal account. The link expires in 24 hours.
    </p>
    <p><a href="{{ .ConfirmationURL }}">Accept invite and set password</a></p>
    <p>If you weren't expecting this, you can ignore this email.</p>

Leave the **Confirm signup** and **Reset password** templates at defaults
unless product wants bespoke copy; confirm signup is only used if public
signup is ever turned on.

## 4. JWT / token settings

Authentication → Settings

- **JWT expiry**: 3600 (1 hour) — default is fine
- **Refresh token reuse detection**: ON (default)

No session-pinning or MFA for v1.

## 5. Service role key (server-side only)

The invite flow (`api/vendor-invite.js`, added in Phase 1) calls
`supabase.auth.admin.inviteUserByEmail(...)` which requires the service role
key. Store it as a Vercel environment variable:

- **Name**: `SUPABASE_SERVICE_ROLE_KEY`
- **Value**: copy from Supabase Dashboard → Project Settings → API → `service_role`
- **Environments**: Production + Preview + Development
- **Never** prefix it with `VITE_` (prevents bundling into the frontend).

Mirror the entry (blank) into `.env.local.example` so local dev picks it up.

## 6. Verification checklist

After applying 1–5:

- [ ] Invite yourself (from the admin UI added in Phase 1.3) at your own
      email, using a throwaway `vendor_id`.
- [ ] Confirm the invite email arrives and the link lands on
      `/vendor/setup`.
- [ ] Set a password, confirm redirect to `/vendor` with a populated PO list.
- [ ] Sign out, sign back in via `/vendor/login`.
- [ ] Try signing in with an internal user's email — must fail (no row in
      `vendor_users`).

## Notes

- Supabase Auth and the internal custom auth (`app_data['users']`,
  `src/utils/hash.ts`) share a Supabase project but not a user pool. An
  internal staff member who also needs portal access would have *two*
  accounts. That's intentional for Phase 1; consolidation is out of scope.
- RLS on `tanda_pos` / `vendors` / `vendor_users` (see
  `supabase/migrations/0004_rls_policies.sql`) is what actually isolates
  vendors from each other. Auth alone does nothing — if RLS is disabled on
  any of those tables, a logged-in vendor could read all POs.
