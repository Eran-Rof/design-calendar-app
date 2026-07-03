# 1 — Getting Started & Navigation

This chapter is your map to the whole Ring of Fire app suite: how to reach it, how to sign in, what each app does, and how access is controlled. If you only read one chapter before your first day on the system, read this one.

## Who this guide is for

Everyone at Ring of Fire who touches the suite day-to-day — the CEO reviewing status, designers tracking briefs and tech packs, product developers costing and sourcing, and the ops team running purchase orders, inventory and accounting. The suite is a single set of apps that share one login and one set of master data; you only see the apps and panels your account is allowed to use.

## The front door

There are two ways into the suite, depending on how your environment is set up. Both ask you to sign in once and then drop you into the apps.

| Front door | What you see | Sign-in method |
|---|---|---|
| **PLM launcher** (the classic home) | A grid of app cards under the Ring of Fire logo and the word **PLM** | Username + password |
| **Tangerine sign-in** (the future home) | A dark, orange-accented card titled **Sign in to the suite** | Microsoft 365 work account |

> **Which one will I get?** Today most users land on the **PLM launcher** at the site root. There is a planned switch that makes the **Tangerine sign-in** the single front door for the whole suite — when that switch is turned on, the root address sends you straight to the Tangerine sign-in and the classic launcher is retired. Either way, your bookmarks for individual apps (like `/tanda` or `/costing`) keep working.

> **Use the apps.ringoffire.com address.** Always reach the suite at **apps.ringoffire.com**, not at any `*.vercel.app` address. The Vercel preview addresses sit behind an extra Microsoft sign-in wall that breaks the apps in confusing ways (blank cards, "Unexpected token" errors). If you have an old `*.vercel.app` bookmark, replace it with the apps.ringoffire.com one.

## Signing in

### The PLM launcher (username + password)

1. Open your browser to the suite home (apps.ringoffire.com).
2. You'll see the Ring of Fire logo, the word **PLM**, and a sign-in card.
3. Type your **Username** and **Password**. Click the **eye** icon to reveal the password if you want to check it.
4. Click **Sign In** (or press **Enter**). You land on the app-card grid.

If you forget your password, click **Forgot password?** below the Sign In button, enter your email, and submit. If an account exists for that address, a reset email is sent (the link is valid for one hour). Follow the link, choose a new password (at least 8 characters), and sign in again.

> **Tip:** the launcher remembers your last username and pre-fills it next time, so you usually only type your password.

### The Tangerine sign-in (Microsoft 365)

1. Open the suite (or go directly to the Tangerine app).
2. You'll see the orange 🍊 **Tangerine** card titled **Sign in to the suite**.
3. Click **Sign in with Microsoft**. A Microsoft pop-up opens — sign in with the same work account you use for Outlook, Teams and the rest of Microsoft 365.
4. The pop-up closes and you're taken into the app.

> **Already signed in? You won't be asked twice.** If you reached the suite through the **PLM launcher** (username + password) and then open **Tangerine ERP** from a launcher card or an **🧩 Apps** menu, Tangerine recognises that you are already signed in and opens **directly** — it does **not** put up a second "Sign in with Microsoft" screen. The Microsoft sign-in card only appears for people who open Tangerine as a standalone front door without having signed in elsewhere first. And if your browser already holds a valid Microsoft session, the standalone Tangerine sign-in page recognises it and passes you straight through without asking again.

> **Pop-up blocked?** If the Microsoft pop-up doesn't appear, your browser is blocking pop-ups for this site. Allow pop-ups for the suite address and click **Sign in with Microsoft** again. The sign-in card shows a "Sign-in failed" note if this happens.

The Tangerine sign-in also exists as its own standalone page so it can be used even by people who never open the classic launcher.

## The app-card grid

Once you sign in to the PLM launcher, you see a grid of cards — one per app. Click any unlocked card to open that app. Apps you're not allowed to use appear as a faded card with a **🔒 No Access** badge and can't be clicked (see *How access works*, below).

Every app in the suite, what it's for, and its address:

| Card | App | What it's for | Address |
|---|---|---|---|
| 🎨 | **Design Calendar** | Seasonal design workflow — task tracking, collections, and vendor milestones | `/design` |
| 📋 | **PO WIP** | Purchase-order tracking, Xoro sync, and delivery management (also called T&A / Time & Action) | `/tanda` |
| 📐 | **Tech Packs** | Tech packs, spec sheets, costing, approvals, materials and sample tracking | `/techpack` |
| 📦 | **ATS** | Available-to-Sell — inventory snapshot grid, Xoro sync and Excel upload | `/ats` |
| 🤝 | **Vendor Portal** | The external-facing portal where vendors manage POs, invoices, compliance, RFQs and payments | `/vendor` |
| 📊 | **Inventory Planning** | Wholesale + ecom forecasts, supply reconciliation, scenarios, accuracy and the AI co-pilot | `/planning` |
| 🏷️ | **GTIN Creation** | GS1 prepack GTIN generation, packing-list upload, label batch printing and CSV export | `/gs1` |
| 💰 | **Costing** | Costing projects — multi-vendor quotes, last-year and trailing-3-month comparisons, margin targeting | `/costing` |
| 🍊 | **Tangerine ERP** | Accounting, inventory, sales, procurement and finance — the system replacing Xoro | `/tangerine` |

There are also two external customer-facing surfaces that aren't shown as launcher cards because they have their own separate sign-in: the **B2B wholesale portal** (`/b2b`) for wholesale customers, and the **Vendor Portal** (`/vendor`) for vendors. Internal staff manage vendors from the Vendor Portal card above; the `/vendor` and `/b2b` addresses are what your outside partners use.

> **Apps open in their own tab.** From the launcher and from the in-app **🧩 Apps** menus, clicking an app opens it in a **new browser tab** so the screen you were on stays put. You can keep several apps open side-by-side.

## Top navigation

Each app has its own top bar, but they share the same conventions so you always know where you are.

- **Top-left:** the Ring of Fire logo and the app's name. The logo returns you to that app's home view.
- **Center:** the app's main views or sections (for example, Design Calendar shows **Dashboard · Timeline · Calendar · Trend Briefs**).
- **Right:** your action icons — **Favorites** (always the first icon), an **✨ Ask AI** assistant, a **🔔 Notifications** bell with an unread count, plus your avatar and name.
- **Avatar + name:** your Microsoft profile photo (or your initials on a coloured circle) next to your name. Hover for more detail.
- **← PLM:** in the left navigation drawer (just above **All Apps**), every app has a **← PLM** control that takes you back to the launcher without signing out. It **returns you to the launcher tab you already have open and closes the current app tab** — so you never end up with a stack of duplicate launcher tabs. (If the app was opened directly by address rather than from the launcher, it simply navigates back to the launcher.)
- **Sign Out:** ends your session and returns you to the sign-in screen (in the drawer's user menu, or the top bar).

Within an app, links to related apps appear in the top bar — for example Design Calendar shows quick links to **T&A** (PO WIP) and **Costing**, and Tangerine has a **🧩 Apps** menu that links out to every other app in the suite. These links respect your access: you only see a link to an app you're allowed to open.

> **The browser tab title follows your current screen** — for example the tab reads "Timeline · Design Calendar" — so multiple open tabs are easy to tell apart.

> **Consistent dark interface.** Across every app the working screens use the same dark theme — and that now includes all **dropdown / picker fields**: both the closed control and the list of choices that opens use the app's dark colours, so a dropdown never flashes a stray white box. (The PLM launcher home screen is the one intentionally light surface.)

> The 🍊 **Tangerine ERP** app has the deepest navigation in the suite (dozens of accounting, inventory, sales and procurement panels grouped under section dropdowns). It has its own dedicated getting-started guide — see the Tangerine user guide for its nav layout, **🔍 Find a panel** search box, and Favorites.

## How access works

Access in the suite is controlled **per app, per user**. Your account carries an access setting for each of the nine apps.

- **Default is "allowed."** If your account has no specific setting for an app, you can use it. This means new apps light up for existing users automatically — nobody has to be re-granted access every time an app is added.
- **Admins see everything.** If your role is **admin**, you have access to every app regardless of individual settings.
- **Explicit "no access" blocks you.** An administrator can switch a specific app off for a specific user. When that happens you see the app's card greyed out with a **🔒 No Access** badge, and if you try to open the app's address directly you get a "Your account does not have access" screen with a link back to the launcher. The locked card is a courtesy; the address itself also refuses, so there's no way around it.

Administrators manage who can use what under **User Management** inside the launcher (and per-app fine-grained settings, such as which ATS reports a user can see, live there too).

> **Inventory Planning has an extra gate.** Beyond the normal per-app access, Inventory Planning can be limited to a beta access list in some environments. If you have app access but aren't on the beta list (or planning isn't switched on in your environment), you'll see an "Inventory Planning is not enabled / not on the beta access list" message instead of the app. Ask an administrator to add you.

> **Vendor and B2B portals are separate.** The Vendor Portal and the B2B customer portal use their own sign-in and session, completely isolated from internal staff accounts. Signing out of an internal app does not sign out a vendor or wholesale customer, and vice-versa.

## Staying signed in — and automatic logout

For security, the internal apps log you out automatically after **one hour of inactivity** (no clicks, typing or scrolling). In Design Calendar you'll get a warning banner at the 55-minute mark — "You've been inactive for 55 minutes. You'll be automatically logged out in 5 minutes." — with an **I'm still here** button you can click to stay signed in. Any activity resets the clock.

The external Vendor Portal and B2B portal manage their own sessions separately and are not affected by this one-hour internal timeout.

> **Tip:** if you come back to a tab and find yourself logged out, that's the idle timeout doing its job — just sign in again. Your work is saved continuously as you go, so you won't lose anything.

## Environment banners

If you see a coloured banner pinned across the top of the screen, you are **not** on the live production system:

- A **DEMO** banner means you're in a sandbox where external integrations return canned data — safe for training and demos, but nothing here is real.
- A **STAGING** banner means you're on the pre-release test environment.

On the real production system there is no banner. Always check for a banner before entering live data.

## Quick troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| Blank cards, or an "Unexpected token" error | You're on a `*.vercel.app` address behind the extra sign-in wall | Switch to **apps.ringoffire.com** |
| A card is greyed out with **🔒 No Access** | Your account isn't allowed that app | Ask an administrator to grant access in User Management |
| "Your account does not have access" full-screen message | Same as above, reached by opening the address directly | Use the **← Back to launcher** link and request access |
| Microsoft pop-up never opens | Browser is blocking pop-ups | Allow pop-ups for the suite address, then click **Sign in with Microsoft** again |
| Suddenly signed out | One-hour idle auto-logout | Sign in again; your data was saved as you worked |
| Inventory Planning shows "not enabled / not on the beta list" | Planning beta gate | Ask an administrator to add you to the planning list |
