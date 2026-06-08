# PO WIP — Tanda (Tracking & Analysis)

**Route:** `/tanda` · **Entry:** `src/TandA.tsx` (+ `src/tanda/`) · **Users:** production / ops team

## What it is

PO WIP tracks every purchase order from **order → in-house (DDP)** through a
chain of **production milestones**. Where ATS answers "what can I sell," PO WIP
answers "where is each PO in production and when does it land." POs are mirrored
from Xoro; the milestone timeline is maintained by the ops team.

## The milestone model (`tanda_milestones`)

Each PO carries a series of milestones counting down to delivery:

- **phase** — e.g. *Lab Dip / Strike Off*, *Trims*, *PP Approval*, *Prod Start*, **In House / DDP**
- **category** — Pre-Production · Fabric T&A · Samples · Production · Transit
- **days_before_ddp** — countdown anchor (Lab Dip ≈ 120; **In House / DDP = 0**)
- **expected_date** = DDP − days_before_ddp · **actual_date** (when completed) · **status** (Not Started / In Progress / Complete / Delayed / N/A)

Default phase set: `DEFAULT_WIP_TEMPLATES` in `src/utils/tandaTypes.ts`; vendors
can have customized templates (Templates view). The **"In House / DDP"**
milestone (days_before_ddp = 0) is the authoritative expected arrival date.

## Key surfaces (`src/tanda/`)

- **Views:** Dashboard (overdue / completion / cascade alerts), Grid (PO × milestone matrix, inline status edit), List, Archive, Templates (per-vendor phases), Vendors, Shipments, Activity.
- **Detail panel** (`detailPanel.tsx`): milestones tab, notes/attachments (Dropbox) + audit trail, PO line matrix (`poMatrixTab.tsx`), email/history tabs.
- **Hooks:** `useSyncOps` (Xoro fetch → upsert → DDP cascade), `useMilestoneOps` (CRUD + auto-delay overdue + template apply), `useArchiveOps` (archive / permanent-delete + tombstone), `useNotesOps`, `useDashboardData`, `useTemplateOps`, `useEmailOps`/`useTeamsOps` (MS Graph). State via Zustand (`src/tanda/store/`).

## Sync + delete behavior

- **Source:** `tanda_pos` (PK `po_number`, plus the full Xoro PO JSON in `data`). Populated by a browser "Sync" and a **nightly Xoro cron** (`api/_handlers/tanda/sync-from-xoro.js`) over active statuses (Open / Released / Partially Received). On re-sync, milestone dates **cascade** from the PO's DDP and the user's `buyer_po` override is preserved.
- **Archive / tombstone:** deleting a PO sets `_archived` (soft); a permanent delete writes a `tanda_po_tombstones` row, and the nightly sync **skips tombstoned PO numbers** so Xoro can't re-add them.
- **Nightly Xoro AP sync** (`api/cron/xoro-ap-sync.js`, 02:30 UTC): pulls vendor-bill paid status from Xoro into `invoices` (30-day lookback, idempotent) — keeps AP status current alongside the PO sync.

## How it connects to other apps

- **→ ATS:** `src/ats/hooks/usePOWIPSync.ts` folds `tanda_pos` into the ATS grid as incoming `onPO` supply.
- **→ Inventory Planning:** `api/_lib/planning-sync.js::syncOpenPosFromTandaPos()` (via `POST /api/planning/sync-open-pos`) projects open `tanda_pos` lines into `ip_open_purchase_orders`. **The "In House / DDP" milestone date now times that incoming supply** in planning — "inbound PO is WIP" (M31/P17 step 5; see [`33-…` §33.8](../tangerine/user-guide/33-inventory-planning-to-tangerine-po.md)).
- **→ Tangerine Procurement:** Tangerine has its own native `purchase_orders` (the ERP source of truth); `tanda_pos` is the Xoro mirror for production tracking. Goods receipts land in `tanda_po_receipts`, feeding QC inspections and 3-way match (`InternalThreeWayMatch`, `InternalQCInspections`).

## Grid — Named Range filter (PO # column)

The **Grid** view's PO # column carries a **Range** button in the header filter
row. Click it to filter the grid by **either**:

- **By Date** — the PO **creation date** (`DateOrder`). Enter a *From* date for
  "that date or newer"; add an optional *To* date to close the window.
- **By PO #** — the **last 6 digits** of the PO number (`ROF-P001263` → `1263`).
  Enter a *From* number for "that number or greater"; add an optional *To* to cap it.

*From* alone is enough — the *To* field is always optional (open-ended range).
When a range is applied the grid **auto-sorts ascending by the chosen axis**
(creation date or PO number), and the button turns purple with a • marker.
Use **Clear** in the popover to remove the range. The selection persists across
reloads (`gv_range_filter`).

## Recent additions

- **Grid PO # Named-Range filter** — date-range (creation date) or PO-number-range filter with optional upper bound; auto-sorts by the chosen axis.
- **Vendor onboarding / portal access** — operator "Onboarding review" (`src/tanda/InternalOnboarding.tsx`): invite vendors, track invite status (pending / expired / accepted, 72h expiry), and an admin to view + cancel vendor portal access. Vendors self-serve via the `/vendor` portal onboarding flow.
- **Tombstone table** — prevents permanently-deleted POs from re-appearing after the nightly sync.

## See also
- [ats-overview.md](ats-overview.md) · [inventory-planning-overview.md](inventory-planning-overview.md)
- Tangerine Procurement: [`docs/tangerine/user-guide/32-procurement-receiving.md`](../tangerine/user-guide/32-procurement-receiving.md)
