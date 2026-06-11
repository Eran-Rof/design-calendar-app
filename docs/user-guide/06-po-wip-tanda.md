# 6 — PO WIP (Production Work-In-Progress)

PO WIP is the app the production and ops team lives in. It tracks **every purchase order from the day it's placed through each production milestone until it lands in-house (DDP)**. Where the Planning/ATS app answers "what can I sell," PO WIP answers "where is each PO in production and when will it arrive."

Open it at **`/tanda`** (the app is branded **PO WIP** at the top of its left navigation drawer). You can also jump to it from the **🧩 All Apps** switcher at the bottom of the drawer, the Tangerine launcher, or the PLM home launcher.

> **A note on the name.** Internally this app is called "Tanda" — you'll still see that word in some bookmarks and links. The operator-facing name is **PO WIP** (Purchase Orders). They are the same app.

## How PO WIP gets its data

You don't type purchase orders into PO WIP. POs are **mirrored from Xoro**, our order system. There are two ways the mirror is kept current:

1. **Nightly automatic sync** — every night the app pulls active POs from Xoro on its own. You don't have to do anything.
2. **Manual sync** — when you need fresh data right now, click **🔄 Sync POs** (see [§6.9](#69-syncing-from-xoro)).

Only **active** statuses are pulled: **Open, Released, Partially Received, Pending, Draft**. POs that Xoro marks **Closed, Received, or Cancelled** are dropped from the active list automatically.

What you *do* maintain in PO WIP is everything that Xoro doesn't track: the **production milestone timeline**, **notes**, **attachments**, the **Buyer / Buyer PO** fields, and per-vendor **production templates**.

> Each milestone status you set, each note you add, and each Buyer PO you enter is **preserved across syncs** — re-syncing a PO never wipes your work. When a PO's delivery date changes in Xoro, the milestone dates **recalculate (cascade)** around the new date but your statuses stay put.

## The navigation drawer

PO WIP uses the **shared left navigation drawer** (the same one as the other suite apps). It lists every view, grouped into collapsible sections, and remembers which sections you've opened. The **◀ / ▶** control at the top collapses the drawer to a slim icon rail and back — your choice is remembered between visits.

Down the drawer you'll find:

- **Your name + avatar** — click it to **Sign out**.
- **🔍 Search modules** — start typing ("grid", "archive", "templates") and press **Enter** to jump straight to the top hit.
- **⭐ Favorites** — star the current view (the ☆ next to the Favorites header) to pin it to the top of the drawer.
- **Module sections**, each click-to-expand:
  - **Purchase Orders** — Dashboard · All POs · Grid · Timeline · Archive · Templates.
  - **Collaboration** — Teams · Email · Activity.
  - **Vendors** — Directory, Onboarding, Preferred, Scorecards, Health Scores, Diversity, Sustainability, ESG Scores.
  - **Operations** — Shipments, 3-Way Match, Messages, Phase reviews, Anomalies, Workspaces.
  - **Compliance** — Documents, Automation, Audit trail.
  - **Sourcing** — RFQs, Marketplace, Inquiries, Benchmark, Insights.
  - **Finance** — Payments, Discount offers, SCF, Virtual cards, FX, Tax.
  - **Analytics & Admin** — Analytics, Spend, Workflow Rules, Approvals, Entities.
- **🧩 All Apps** (bottom) — switch to any other suite app.

A **slim top bar** to the right of the drawer holds the actions that aren't views:

- **✨ Ask AI** — ask plain-English questions about POs, vendors, shipments, invoices. Answers come from live data and this guide.
- **🔔 Notifications** — your alert inbox, with an unread-count badge.
- **⭐ Favorites** picker and a **🔍 Find a view** finder.
- **⚡ Bulk** (bulk milestone update), **🔄 Sync** (pull fresh POs from Xoro — see [§6.9](#69-syncing-from-xoro)), **⚙️ Settings**, and **← PLM** (back to the launcher).

The four core working views — **Dashboard, All POs, Grid, and Archive** — are the ones you'll use daily and are covered below.

## 6.1 The Dashboard

The Dashboard (**Purchase Orders → 🏠 Dashboard** in the drawer) is your at-a-glance production health view. It opens with a search box at the top — type a PO #, vendor, brand, or style number to filter everything below.

Key elements, top to bottom:

| Tile / panel | What it shows |
|---|---|
| **Production Health Score** | A 0–100 ring. Green ≥ 80, amber 60–79, red below 60. Based on completed-vs-active milestones, penalized for delays. Click it to open the Timeline. |
| **Total POs / Total Value** | Count and dollar value of active POs. |
| **Overdue POs / Due This Week** | POs past or near their DDP. |
| **Overdue Milestones / Due This Week** | Milestone-level counts. |
| **Completion Rate** | Percentage of milestones marked Complete. |
| **Cascade Alerts** | Count of POs whose later phases are **blocked** because an earlier phase is running late. |
| **Milestone Pipeline** | Bar breakdown: Not Started / In Progress / Delayed / Complete. |
| **Progress by Category** | Completion bars for each of the five WIP categories. |
| **POs by Status** | Clickable status chips (Open, Released, etc.) that filter All POs. |
| **Top Vendors** | The five vendors with the best on-time milestone percentage. |
| **⚠ Cascade Alerts table** | Lists each blocked PO, which phase is delayed, and how many days late. Click a row to open that PO at the blocked phase. |
| **Upcoming / Overdue Milestones** | Two side-by-side lists; click any row to open the PO's Milestones tab. |
| **Recent Purchase Orders** | The latest POs (or your search results). |

Every tile and row is clickable — they're shortcuts into the deeper views.

## 6.2 All POs (list)

**Purchase Orders → All POs** (in the drawer) is the simple card list. Use the filter bar at the top:

1. **🔍 Search** — matches PO #, vendor, brand, style #, and memo.
2. **All PO Statuses** dropdown — filter to one status.
3. **All Vendors** dropdown — filter to one vendor.
4. **Sort by** — DDP date, PO date, or Status.
5. **Direction button** — toggles the order (e.g. "↓ Oldest first" ↔ "↑ Newest first"; for Status it reads "Delayed first" / "Completed first").
6. **Clear** — resets every filter.

A counter reads "Showing X of Y purchase orders" along with the last sync time. **Click any PO card to open its detail panel** ([§6.6](#66-the-po-detail-panel)). If no POs are loaded at all, an empty state offers a **🔄 Sync from Xoro** button.

## 6.3 The Grid (PO × milestone matrix)

The **Grid** (**🗂 Grid**) is the power view — one row per PO, with every production phase laid out in columns across the page. For each phase it shows **Due Date · Status · Status Date · Days · Notes**. This is where most milestone work happens because you can scan and edit many POs at once.

### Reading and editing the grid

- The first columns are fixed: **PO #, Vendor, Buyer, Buyer PO, DDP, Days from DDP**.
- **Click a status cell** to change a milestone's status inline (Not Started / In Progress / Complete / Delayed / N/A). The status date stamps automatically.
- **Click a date cell** to edit a phase's expected date, or edit the **DDP** to re-anchor the whole timeline.
- **↩ Undo** reverses your last change (including a full cascade as one step).
- Each PO row has a chevron to **expand** it into either its line items or its size matrix (toggle **line / matrix**).

> **DDP changes ripple.** If you edit a phase date in a way that implies a new in-house date, the app asks you to confirm; on confirm it shifts **every** phase to keep the same days-before-DDP spacing, updates the DDP, and drops an automatic note recording the change. POs whose DDP you changed this session are highlighted orange.

### Sorting

Click any of the six fixed-column headers (PO #, Vendor, Buyer, Buyer PO, DDP, Days from DDP) to sort. Clicking cycles **ascending → descending → off**. Blanks always sort to the bottom. Your choice is remembered across reloads.

### Show / hide and freeze columns

- The **⚙ Columns** control lets you hide any of the fixed data columns; hidden columns stay hidden across reloads.
- You can **freeze** columns through a chosen point so the PO context stays pinned while you scroll right through the phase columns.

### The Range filter (PO # column)

The PO # column header carries a **Range** button. Click it to narrow the grid by either:

- **By Date** — the PO **creation date**. Enter a *From* date for "that date or newer"; add an optional *To* date to close the window.
- **By PO #** — the **last digits** of the PO number (e.g. `ROF-P001263` → `1263`). Enter a *From* number; add an optional *To* to cap it.

*From* alone is enough — *To* is always optional. When a range is active the grid **auto-sorts ascending** by the chosen axis and the button shows a purple • marker. Use **Clear** in the popover to show all POs again.

> If a range matches **no POs**, the grid drops it automatically and shows everything again, with a brief amber notice ("No POs matched that range — showing all POs"), so you're never stranded on an empty page. The range selection survives reloads.

### Export

Use the grid's **Excel export** to download the full PO × milestone matrix — every phase with its due dates, statuses, status dates, days-remaining, and notes — formatted in the standard Ring of Fire styling with the logo banner.

## 6.4 The milestone model

Every PO carries a chain of **milestones** counting down to delivery. Each milestone has:

- A **phase** name (e.g. *Lab Dip / Strike Off*, *PP Approval*, *Prod Start*, *Ex Factory*, *In House / DDP*).
- A **category** — one of five: **Pre-Production · Fabric T&A · Samples · Production · Transit**.
- **Days before DDP** — how far ahead of the in-house date the phase should land.
- An **expected date** (= DDP minus days-before-DDP), an optional **actual/status date**, and a **status**.

The standard phase set runs from **Lab Dip / Strike Off** (~120 days before DDP) down to **In House / DDP** (0 days). The **"In House / DDP" milestone is the authoritative expected arrival date** — it's what the Planning app uses to time incoming supply.

**Milestone statuses and their colors:**

| Status | Meaning | Color |
|---|---|---|
| Not Started | Phase hasn't begun | Grey |
| In Progress | Underway | Blue |
| Complete | Done | Green |
| Delayed | Behind schedule | Red |
| N/A | Doesn't apply to this PO | Grey |

> **Cascade / blocked logic.** Categories run in order. If an earlier category isn't fully Complete (or N/A) and is overdue, later categories are flagged **blocked** — these are the Cascade Alerts on the Dashboard. They tell you a downstream phase can't realistically start because an upstream one is late.

## 6.5 Production templates (lead times)

The phase list and its days-before-DDP spacing come from a **production template**. **📐 Templates** (**Purchase Orders → 📐 Templates** in the drawer) is where you manage them.

- Use the **Vendor** dropdown to pick **Default Template** or a vendor-specific one. The Default is used for any vendor that doesn't have its own.
- The table lists each phase with its **#, Phase, Category, Days Before DDP, and Status**.
- **Admins** can edit cells inline, **drag rows** by the ⠿ handle to re-order phases, delete a phase (✕), and **↩ Undo** / **Save** their changes. An "Unsaved changes" flag warns before you switch vendors.
- **+ New Vendor Template** — type or pick a vendor and **Copy from** the Default or another vendor's template as a starting point.
- **Delete Template** removes a vendor's custom template; that vendor falls back to the Default.

Non-admins see the template **view-only**.

> When you open the Grid, PO WIP automatically generates milestones for any PO that has a DDP and whose vendor has a template. If you later add phases to a template, existing POs **fill in the new phases** the next time you view them. A PO with no matching template simply waits until one exists.

## 6.6 The PO detail panel

Clicking any PO opens its full detail panel. Up top you see the PO header (vendor, dates, currency, totals), an editable **Buyer PO** field, and a **Production Progress** bar showing percent complete, milestone counts, delays, and per-category chips you can click to jump to a category.

Tabs across the detail panel:

| Tab | What's in it |
|---|---|
| **PO / Matrix** | The size matrix (base part × color × size) plus the raw line-items table. |
| **Milestones** | The full phase list grouped by category, with status/date editing, per-phase notes, regenerate, and add-phase. |
| **Notes** | PO-level notes with author and date. |
| **📎 Files** | Attachments (uploaded documents). |
| **📧 Email/Teams** | Email threads and Teams messages tied to this PO (covered in the Collaboration chapter). |
| **History** | The audit trail of every change to this PO. |
| **All** | Shows every tab stacked on one page. |

### The size matrix (PO / Matrix tab)

The matrix groups line items into a grid of **Base Part × Color**, with one column per **size** and a **Total / PO Cost / Total Cost / Delivery** set on the right. A grand-total footer sums each size column and the dollar totals.

- **Closed lines** (cancelled on Xoro) are shown struck-through with a red **CLOSED** badge and excluded from the totals.
- The **EXPLODE PPK** toggle (top-right of the matrix) controls how prepack rows are counted. **On** = totals show **units** (packs × units-per-pack) with a faded "N packs" hint; **off** = totals show the raw **pack** count. Your choice is remembered as you move between POs.
- If a line's delivery date differs from the PO header date, it's highlighted amber so split deliveries are obvious.

### Milestones tab

Phases are grouped by category, sorted by expected date. You can set each phase's status, set/clear dates, and add per-phase notes (each note records who wrote it and when). **Generate Milestones** appears for a PO that has a DDP and a vendor template but no milestones yet; **Regenerate** rebuilds the list while **preserving your statuses, dates, and notes**.

## 6.7 Bulk update

For repetitive changes, use the **⚡ Bulk** button in the top bar. Pick a **vendor**, optionally narrow to specific **POs**, **phases**, or a **category**, choose a target **status**, and apply. PO WIP updates every matching milestone in one pass (and auto-generates milestones for any selected PO that didn't have them). It skips milestones already at the target status or marked N/A, and logs the change to history.

## 6.8 Archive, restore, and permanent delete

POs you no longer want in the active list go to the **Archive** (**📦 Archive**). Archiving is a **soft** action — milestones, notes, and attachments are all preserved.

In the Archive view:

1. **Search / filter** by PO #, vendor, or status.
2. **↩ Restore** a single PO, selected POs, or **Restore All** to send them back to the active All POs list.
3. **🗑 Delete** permanently removes a PO and all its data.

You can act on one PO via its row buttons, or tick checkboxes (including the header "select all") and use the bulk **Restore Selected** / **Delete Selected** buttons, or **Delete All Filtered**.

> **Permanent delete is final and confirmed.** Deleting wipes the PO, its milestones, and its notes — it cannot be undone. To stop the nightly Xoro sync from simply re-adding a PO you deleted (Xoro may still see it as active), permanent delete writes a **tombstone**. The nightly sync **skips tombstoned PO numbers**, so a permanent delete stays deleted.

> **Restore caveat.** If you Restore All, any PO that Xoro still considers Closed / Received / Cancelled will be **re-archived on the next sync** — those belong in the archive by rule.

## 6.9 Syncing from Xoro

To pull fresh data on demand, click the **🔄 Sync** button in the top bar (or the **🔄 Sync from Xoro** button on an empty list). The sync modal lets you scope what gets pulled:

| Filter | Behaviour |
|---|---|
| **PO Number** | Search and pick one or more PO numbers, or leave blank for all. |
| **Date Created — From / To** | Limit to POs created in a date window. |
| **Status** | Tap to select one or more statuses, or leave blank for all. |
| **Vendor** | Search and check one or more vendors; you can also add a vendor manually. |

POs sync **one status at a time** to avoid timeouts — if one status fails, the sync skips it and continues. When it finishes you get an **Added / Updated / Removed** summary, and a **📋 Sync Log** is available for detail. A live progress bar shows the run, and you can **✕ Cancel sync** while it's running. Sync errors appear in a clear modal you can dismiss.

> Remember: a manual sync is only ever a convenience. The nightly automatic sync keeps PO WIP current even if you never click the button.

## 6.10 Activity, Settings, and column preferences

- **📋 Activity** (**Collaboration → 📋 Activity** in the drawer) is a chronological log of changes across all POs.
- **⚙️ Settings** holds app-level options (including email/Teams connection).
- **Column visibility is per-user.** Wherever a table offers the **⚙ Columns** control, the columns you hide are saved to *your* profile and persist across devices and reloads. Newly added columns always appear by default. A "Select all" toggle and **Reset to default** keep things tidy. The same applies to **column sorting** — clicking a sortable header cycles ascending → descending → off and your preference is remembered.

## 6.11 How PO WIP connects to the rest of the suite

- **→ Planning / ATS** — open POs flow in as incoming supply. The **"In House / DDP"** milestone date is what times that inbound supply in Planning ("inbound PO is WIP").
- **→ Tangerine Procurement** — Tangerine has its own native purchase orders (the ERP source of truth); PO WIP is the **Xoro mirror used for production tracking**. Goods receipts there feed QC inspections and 3-way match.
- **Drop-ship and 3PL panels.** Two related operational screens live in this app's codebase but are reached from **Tangerine** rather than the PO WIP nav: **Drop-Ship** (Sales → 📦 Drop-Ship — vendor ships straight to the customer; lifecycle requested → confirmed → shipped → delivered → closed) and **3PL** (Inventory → 🚚 3PL — third-party logistics **Providers** + inbound/outbound **Shipments**, lifecycle draft → in_transit → received → closed). Both carry **Export** buttons and use searchable pickers so you never see raw IDs. See the Procurement and Inventory chapters for full coverage.

## 6.12 Day-to-day workflows

**Morning health check**
1. Open the **Dashboard**.
2. Glance at the **Production Health Score** and the **Overdue / Cascade Alerts** tiles.
3. Click any red Cascade Alert row to jump to the blocked PO and chase the late upstream phase.

**Updating production progress**
1. Open the **Grid**.
2. Filter to your vendor (or use the **Range** filter to a date / PO-number window).
3. Click status cells to mark phases In Progress / Complete / Delayed; the status date stamps itself.
4. If a real-world date slips, edit the phase or DDP date and confirm the cascade.

**A delivery date moved**
1. Open the PO's **Milestones** tab (or its DDP cell in the Grid).
2. Change the DDP — confirm the cascade. Every phase shifts to keep its spacing, and an automatic note records the change.

**Closing out a PO**
1. When a PO is delivered and you don't need it active, open the **Archive** flow from its detail panel or send it to Archive.
2. It stays fully recoverable. Only use **permanent delete** for genuine mistakes — that writes a tombstone so Xoro can't re-add it.

**Setting up a new vendor's lead times**
1. Open **Templates**.
2. **+ New Vendor Template**, copy from Default, and adjust the **Days Before DDP** per phase.
3. Save. New POs for that vendor will generate milestones on this schedule automatically.
