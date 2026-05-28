# Cross-cutter T4 — Personalization (Favorites + Personalized Landing)

Status: **PLAN ONLY** (2026-05-28). No implementation chunk has shipped yet. Operator request: "do we have in the plan a way for a user to mark as favorites any menu item and have those menu items open on a side menu? if not add to plan and memory. also we don't need the large cards on app main page rather open page on each user's most used feature."

This is a cross-app feature (Design Calendar, PO WIP, Tech Packs, ATS, GS1, Planning, Vendor Portal, Tangerine) — not Tangerine-specific. Lives in the cross-cutter T-chunk stream alongside T1 (shell), T2 (OAuth), T3 (table export).

---

## 0. Scope

**In scope:**
- **Favorites side menu** — every nav item (top-nav button, dropdown item, sidebar link) gets a star toggle. Stars persist per user. Starred items appear in a collapsible left-side drawer that opens with a single click — fast access without re-traversing the menu.
- **Personalized landing** — the root URL (`/`) no longer shows the 4-app card grid. Instead it routes the signed-in user to:
  1. Their explicitly-set **default route** (set via Settings → "Open to" dropdown), OR
  2. Their **most-clicked feature in the last 30 days** (auto-tracked), OR
  3. Fallback to the legacy app-launcher grid (only for brand-new users with zero history).
- **Usage telemetry** — light per-user click counters on every menu item so "most used" is real, not heuristic.
- **Settings panel** — small "Personalization" tab under existing user-settings location: manage favorites order, pick / reset default route, see usage stats.

**Out of scope:**
- Team-level / role-based default routes (e.g. "all accountants open to AR Aging") — future enhancement once we have non-CEO users.
- Drag-to-reorder favorites in the side drawer — v1 ships with simple add/remove + alphabetical sort; reorder is v2.
- "Recent items" beyond the top-N most-clicked — keeping the side drawer purposefully small.
- Mobile-specific drawer behavior (overlay vs push) — desktop-first; mobile gets a sensible default that we tune later.

---

## 1. Existing state

- Root `App.tsx` renders a 4-card app launcher (DC / PO WIP / Tech Pack / ATS) when no app is selected. GS1 / Planning / Vendor Portal are reachable from in-app launchers (not the root grid).
- Tangerine has its own top-nav group dropdowns (P5 menu rework) but no favorites surface.
- No `user_preferences` or `user_settings` table exists. Per-user state today is localStorage-only (e.g. ATS filter persistence) — does not survive a fresh device.
- No click-tracking table exists.

---

## 2. Decisions (recommended — operator to confirm at implementation time)

| # | Decision | Recommendation | Why |
|---|---|---|---|
| T4-D1 | Storage | **Supabase `user_preferences` table** (server-side, multi-device) | localStorage today doesn't survive across the operator's Mac + Windows workstations |
| T4-D2 | Telemetry granularity | **Aggregate click counter per menu_key**, rolling 30-day window | Avoids row-per-click bloat; supports "most used" sort |
| T4-D3 | Menu-key namespace | **Global string namespace** (e.g. `tangerine:trial-balance`, `ats:planning`, `dc:calendar-grid`) | Cross-app uniqueness; one favorites list spans all apps |
| T4-D4 | Side drawer position | **Left side**, collapsible icon-strip when collapsed + 240px wide when expanded; remembers state per user | Standard pattern; right side conflicts with vendor-portal context panels |
| T4-D5 | Fallback for new users | **Show the legacy app-launcher cards** when usage count is zero (no recent activity) | Avoids confusing first-time landing; cards stay as a discovery surface |
| T4-D6 | Star UI placement | **⭐ icon to the right of every nav-item label**, appears on hover (fills when favorited) | Doesn't clutter the default nav; clear affordance |

---

## 3. Schema

```sql
-- Per-user settings table (one row per user × entity × key).
-- Key/value gives us extensibility without ALTERs for new preference types.
CREATE TABLE user_preferences (
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_id    uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  key          text NOT NULL,                  -- 'favorites' | 'home_route' | 'drawer_collapsed' | etc.
  value        jsonb NOT NULL,                 -- shape depends on key
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, entity_id, key)
);

-- Per-user, per-menu-item click counter.
-- Updated by a fire-and-forget POST from every nav click.
CREATE TABLE user_menu_usage (
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_id        uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  menu_key         text NOT NULL,              -- 'tangerine:trial-balance', etc.
  click_count_30d  int  NOT NULL DEFAULT 0,    -- decayed nightly via cron
  click_count_alltime int NOT NULL DEFAULT 0,
  last_clicked_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, entity_id, menu_key)
);

CREATE INDEX idx_user_menu_usage_top
  ON user_menu_usage (user_id, entity_id, click_count_30d DESC);
```

### Value shapes (jsonb per `user_preferences.key`):

| Key | Shape | Example |
|---|---|---|
| `favorites` | `{ items: [{menu_key, label, route, icon, added_at}], v: 1 }` | `{"items":[{"menu_key":"tangerine:trial-balance","label":"Trial Balance","route":"/tangerine?view=trial-balance","icon":"📊","added_at":"2026-05-28T14:00:00Z"}],"v":1}` |
| `home_route` | `{ menu_key, route, v: 1 }` | `{"menu_key":"tangerine:ar-aging","route":"/tangerine?view=ar-aging","v":1}` |
| `drawer_collapsed` | `{ collapsed: boolean }` | `{"collapsed":false}` |

---

## 4. API surface

| Endpoint | Purpose |
|---|---|
| `GET  /api/internal/users/me/preferences` | Returns all preferences for the active user as `{favorites, home_route, drawer_collapsed, top_used: [...]}` |
| `PUT  /api/internal/users/me/favorites` | Replace the full favorites array (idempotent; UI sends after add/remove/reorder) |
| `PUT  /api/internal/users/me/home-route` | Set default landing route. Body: `{menu_key, route}` or `null` to clear |
| `POST /api/internal/users/me/menu-click` | Fire-and-forget click counter. Body: `{menu_key}`. Server upserts on `(user, entity, menu_key)` and increments both counters. |
| `GET  /api/internal/users/me/top-used` | Returns top-N most-clicked menu items in the last 30 days (default N=5). Used by the personalized landing logic. |

The click endpoint is the only high-volume one — debounce client-side to 1 call per route transition.

A nightly cron `bank-feed-sync`-style at `api/cron/menu-usage-decay.js` decays `click_count_30d` by 1/30th every night so the 30-day window is a true rolling average without storing per-click rows.

---

## 5. UI surface

### 5.1 Menu-key registry

Single source of truth at `src/lib/menuKeys.ts`:

```ts
export type MenuItem = {
  menu_key: string;        // 'tangerine:trial-balance'
  app: 'tangerine' | 'ats' | 'dc' | 'powip' | 'techpack' | 'gs1' | 'planning' | 'vendor';
  label: string;
  route: string;           // '/tangerine?view=trial-balance'
  icon: string;            // emoji or unicode
  group?: string;          // 'Accounting' / 'Reports' / 'Master Data' / etc.
  hidden?: boolean;        // true = not user-pickable (e.g. detail views)
};

export const MENU_ITEMS: MenuItem[] = [
  { menu_key: 'tangerine:trial-balance', app: 'tangerine', label: 'Trial Balance', route: '/tangerine?view=trial-balance', icon: '📊', group: 'Reports' },
  // ... ~80 entries across all apps
];
```

Every nav button + dropdown item reads from this registry. The star toggle and click counter use `menu_key` as the stable identifier.

### 5.2 Side drawer

`src/components/FavoritesDrawer.tsx` — left-side fixed drawer. Collapsed = 48px icon strip with just the ⭐ icons; expanded = 240px with labels grouped by app.

Hooks into `usePreferences()` for the favorites array. Click on a favorite navigates via `react-router`.

### 5.3 Star toggle

`src/components/FavoriteStar.tsx` — small ⭐ icon shown on hover next to any nav item. Filled when favorited. Click toggles + persists.

Integrated into:
- Tangerine top-nav buttons + dropdown items
- DC sidebar entries
- PO WIP / ATS / Tech Packs section headers
- App-launcher cards (so "Tech Packs" itself can be a favorite — opens the app)

### 5.4 Personalized landing

`src/components/RootRoute.tsx`:

```tsx
function RootRoute() {
  const { data: prefs, isLoading } = usePreferences();
  if (isLoading) return <Splash />;
  if (prefs?.home_route?.route) return <Navigate to={prefs.home_route.route} />;
  if (prefs?.top_used?.[0]?.route) return <Navigate to={prefs.top_used[0].route} />;
  return <LegacyAppLauncher />;  // fallback for new users
}
```

### 5.5 Settings panel

New "Personalization" tab in user settings (sits next to existing settings surfaces). Three sub-sections:
- **Open to** dropdown — pick a default route (or "Most-used (auto)" or "App launcher").
- **Favorites** — list + remove + (v2) drag-to-reorder.
- **Recent activity** — top-20 most-clicked menu items as a table with click counts; lets the user see what the system would auto-pick.

---

## 6. Cross-app considerations

- **DC + PO WIP + ATS + Tech Packs + GS1 + Planning + Vendor Portal** each have their own internal nav. The favorites drawer is mounted in `src/App.tsx` so it's visible across all apps (except the login page).
- **Vendor portal** users may need a separate scope (vendors star their own routes, never see ROF-internal items). Easy solution: the menu_key registry filters by `vendor_can_see: boolean`. Out of scope for v1 — focus is on the operator first.

---

## 7. Chunk split (when implementation kicks off)

| Chunk | Title | Scope | Depends on |
|---|---|---|---|
| **T4-1** | Schema + click telemetry | `user_preferences` + `user_menu_usage` tables. RLS template (each user reads/writes only their own rows). Nightly decay cron. | — |
| **T4-2** | Menu-key registry + preferences API handlers | `src/lib/menuKeys.ts` with ~80 entries. Handlers for GET preferences / PUT favorites / PUT home-route / POST menu-click / GET top-used. | T4-1 |
| **T4-3** | Star toggle + side drawer | `FavoriteStar` + `FavoritesDrawer` components. Wire into Tangerine nav first (densest menu), then DC / ATS / Tech Packs / PO WIP / GS1 / Planning. | T4-2 |
| **T4-4** | Personalized landing + Settings panel | `RootRoute.tsx` + Settings → Personalization tab. Click-tracker hook fires from every navigate. | T4-3 |
| **T4-5** | User guide chapter 19 + memory update | Doc + cross-cutter close-out. | T4-4 |

Estimated ~3-4 days of work end-to-end once kicked off. T4-1 + T4-2 can run in parallel.

---

## 8. Risks

- **Migration of existing operator behavior:** the CEO already has muscle memory for the 4-card landing. Personalized landing might disorient. Mitigation: ship with the legacy launcher visible from a top-nav "Apps ▾" button (already exists) — so it's reachable, just not the default.
- **Click-telemetry write volume:** ~50-100 nav clicks per user per day × N users. Fine for single-tenant (RoF) but scales linearly. The fire-and-forget pattern + nightly decay keeps the table small (~80 menu_keys × N users = small).
- **Menu-key churn:** as Tangerine grows, menu items get added / renamed. Renaming `menu_key` orphans any user's favorites/home_route — need a one-time data migration per rename, or a tombstone table. Pattern: a `menu_key_aliases` JSON in the registry resolves old keys to new.
- **No-history users:** brand-new users get the legacy launcher (fine), but after they click one thing the auto-landing kicks in — which may not be what they want yet. Mitigation: don't auto-pick a home_route until ≥10 clicks across ≥3 sessions.

---

## 9. Decision when to implement

Not blocking on operator confirmation — T4 implementation can kick off any time after the P7 schemas land. Suggested order: ship P7 Wave A (M16/M17/M47 schemas) first since those are the most-asked phase, then slot T4 between P7 Wave B and Wave C. Alternatively, T4 is a "weekend feel-good" project — small surface, immediate UX win.
