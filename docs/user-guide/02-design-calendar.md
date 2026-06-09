# 2 — Design Calendar

The Design Calendar is Ring of Fire's product-development hub. It lives at `/design` and is where designers, product developers, and the CEO plan every collection from first concept through to delivery. Each collection is broken into a chain of dated phases (Concept, Design, Tech Pack, … DDP), and the app keeps all of them on schedule by working backwards from the delivery date.

> **Who uses it:** designers and product developers run their day from the Dashboard and Timeline; the CEO watches overdue work and collection progress at a glance. Admins also create collections, manage vendors and the team, and set lead-time templates.

## Signing in and the top bar

Open `https://<your-domain>/design`. The app reuses your Microsoft sign-in from the rest of the suite — if you're already signed in (for example via the PLM launcher), it loads straight to the Dashboard. If your session has expired you'll be bounced back to the PLM launcher to sign in again.

The dark header runs across the top of every screen:

| Area | What's there |
|---|---|
| Far left | The Ring of Fire logo and the "Design Calendar" label. |
| View buttons | **Dashboard · Timeline · Calendar · Trend Briefs** — the four main views. |
| **✨ Ask AI** | The Claude assistant (see *Ask AI* below). |
| **🔔 Notifications** | Your design-related notifications, with an unread-count badge. |
| **T&A** / **Costing** | Quick links to the PO WIP (T&A) and Costing apps — open in a new browser tab. Shown only if you have access. |
| Right cluster | Favorites star, **↩ Undo**, the Grid/List toggle, **📋 Activity**, the **⚙️ Settings** menu, your avatar + name, **← PLM**, and **Sign Out**. |

> **Tip — Undo:** the **↩ Undo** button reverses your last change (drag, reschedule, edit). It holds several steps, and the number in parentheses tells you how many are available. Undo is also offered as a banner inside a task card after you change it.

> **Auto sign-out:** after 55 minutes of inactivity you'll see an orange warning banner ("You'll be automatically logged out in 5 minutes"). Click **I'm still here** to stay. After 60 minutes you're signed out automatically.

At the very bottom of the screen sits a slim **nav bar** with a **+ New Collection** button (admins only), four clickable quick-stat counters (Overdue · This Week · Next 30d · Collections), and **💬 Teams** and **📧 Email** buttons. You can hide it with the **▼ Hide Nav** tab on the right edge.

## The three main views

### Dashboard

The Dashboard is your landing screen and command center.

- **Stat tiles.** Three large cards across the top — **Overdue** (red), **Due This Week** (amber), and **Next 30 Days** (blue) — each showing a count of open tasks in that window. Click any tile to filter the screen down to just those tasks; a banner appears with a **✕ Clear Filter** button to return.
- **Task cards** appear when a stat tile is active, each showing the phase, collection, due date, and status. Two of the filters also draw a **mini-calendar**: "Due This Week" shows a 7-day strip, and "Next 30 Days" shows a 30-day grid. You can **drag a task card onto a different day** in either mini-calendar to reschedule it.
- **Overdue banner.** When tasks are overdue and no filter is active, a banner at the top summarizes them.
- **Collections.** Below the tiles is the collection list. The hint reads *"click to focus · right-click for options."* Each collection appears either as a **grid card** or a **list row** depending on the Grid/List toggle in the header.

A collection **grid card** shows the brand, collection name, sample-due date, season/year/gender/category, vendor, DDP and exit-factory dates, customer with order type, start-ship and cancel dates, a **percent-complete** bar, the **next** upcoming phase, the SKU count, colored status dots for each phase (click a dot to open that task), and assignee avatars. Two buttons — **📊 Timeline** and **📅 Calendar** — jump straight into that collection's schedule. Click anywhere on the card to **focus** it (highlighting it); click again to unfocus.

> **Right-click a collection card** for a menu: **Open Timeline**, **Open Calendar**, and (admins only) **Edit Collection** and **Delete Collection**. Deleting a collection permanently removes all its tasks and cannot be undone.

### Timeline

The Timeline lays each collection out as a horizontal **Gantt chain** of phase cards, grouped by brand. Each phase card shows the phase name, status, due date, a **To Complete** countdown (turning amber within a week and red when overdue), and the gap **From Last Task**. The DDP card is outlined in red, the Ship Date card in green, and private-label phases (Line Review, Compliance/Testing, marked **PL REQ**) in purple. The brand header also shows the collection's **samples-due** date.

To **reschedule a phase**, drag its card and drop it into a gap between two other cards, or onto another card to insert just before it. The app:

1. Snaps pre-production phases to the nearest business day (post-PO phases stay on calendar days).
2. Keeps at least one day between neighbouring phases.
3. Saves immediately and records the move so you can **Undo** it.

Click any phase card (when not dragging) to open the **task editor**.

Switch the header toggle to **List view** to see collections as a sortable table instead, with columns **Brand · Collection · Season · Vendor · DDP · Progress · Next Task**. Click a collection row to expand its phases (Phase · Due Date · Business Days Left · Status · Assignee); click a phase row to edit it. The **columns** button (top-right of the table) lets you show or hide columns.

> **Add a one-off task:** on the Timeline, admins see a **+ Add Task** button in the bottom nav bar. Use it to insert a custom phase (e.g. *Proto Review*, *Lab Dip*) into a collection — see *Adding a custom task* below.

### Calendar

The Calendar is a month grid where every phase appears on its due date. The dark header has a collection label on the left (**All Collections**, or the focused collection name with a **✕ Show All** button), month navigation arrows in the centre, and a **Today** button on the right. Each day cell shows up to three task chips — colour-coded by brand, with the DDP phase flagged **🎯** — plus a **"+N more"** count when a day is busy. Today's cell is outlined.

To **reschedule**, drag a task chip onto a different day. A blue banner ("✋ Drag a task to a day to reschedule") confirms drag mode, and the target day highlights as you hover.

> **Created date:** each collection shows a **Created** date so you can see when it was set up. It appears in three places — on the collection card (a small "Created:" line under the customer row), in the Timeline collection header, and in the Calendar header when a collection is focused. The date is stamped automatically when the collection is created and never changes. (Collections created before this feature show their first saved date as a best-effort stamp.)

## Phases and statuses

Every collection is built from the same standard **phase pipeline**, scheduled backwards from DDP:

| Phase | Meaning |
|---|---|
| Concept | Initial idea / direction |
| Design | Design work |
| Tech Pack | Technical specification |
| Costing | Cost the product |
| Sampling | Make and review samples |
| Revision | Revise after sampling |
| Purchase Order | Place the bulk order |
| Production | Manufacture the goods |
| QC | Quality control |
| Ship Date | Exit factory / ship |
| DDP | Delivered Duty Paid — the anchor date all others count back from |

> **Private-label collections** automatically add two extra phases — **Line Review** and **Compliance/Testing** — flagged with a **PL** badge.

Each task carries one **status**:

| Status | Colour |
|---|---|
| Not Started | Grey |
| In Progress | Amber |
| Review | Purple |
| Approved | Green |
| Complete | Dark green |
| Delayed | Red |

Approved and Complete both count toward a collection's percent-complete bar.

## Creating a collection (the Collection Wizard)

Admins click **+ New Collection** (bottom nav bar). The wizard has two steps.

**Step 1 — Brand, Collection & Team**

1. Pick the **Brand**. Private-label brands trigger a note that Line Review & Compliance/Testing will be auto-added.
2. Enter the **Collection Name**.
3. Set **Season**, **Year**, **Gender**, and **Category**. Choosing a category pre-selects a matching vendor.
4. Choose the **Customer** and **Order Type**. The **Channel Type** auto-fills from the customer (you can override it).
5. Assign the **Collection Team** — Product Developer, Designer, and Graphic Artist.
6. Click **Select Vendor →**.

**Step 2 — Vendor & Dates**

1. Pick the **Vendor**. Vendors who specialise in your chosen category are listed first; the rest appear under "── Other vendors ──". A card shows the vendor's country, transit days, and MOQ.
2. The wizard auto-calculates the **DDP date** from the vendor's longest lead time plus transit days. Review the **Task Lead Times** table (Phase · Bus. Days Before DDP · From Prev · Due Date) and edit any value — later phases **cascade** automatically.
3. Set the **Sample Due Date**, and review the auto-calculated **Customer Ship Date** (DDP + 24 days) and **Cancel Date** (Customer Ship + 6 days). All are editable.
4. The **phase preview table** lists every phase with its Days to Complete, Due Date, Bus. Days To DDP, and From Prev gap. Edit any date or days-back value and the rest shift to fit. Past-dated phases are flagged **⚠️ past**, edited ones are tagged **edited**.
5. Click **✓ Create N Tasks**.

> **DDP changes need a decision.** If an edit would move the DDP date, the wizard stops and asks how to handle it: **Accept New DDP Date** (cascade everything), **Proportionally Resize Phase Durations** (compress the phases to keep DDP fixed), **Keep DDP as-is** (move only this one phase), or **Cancel**.

> **No work in the past.** The wizard won't schedule the first phase before today. If the calculated dates would land in the past, it quietly slides the whole chain forward so the first task starts today.

## Editing a task

Click any task card (Dashboard, Timeline, or Calendar) to open the **task editor**. The header shows brand · season · category · vendor, plus customer and order-type chips, and the three key dates (DDP, Cust Ship, Cancel). Four tabs:

| Tab | What you can do |
|---|---|
| **Details** | Change the **Status** (pick from the status pills), the **Assign To** member, and the **Due Date**. A "Days from Previous Task" stepper lets you set the gap directly (business days pre-PO, calendar days post-PO). Add **Notes** — each note is stamped with who wrote it and when. Shows the Collection Team. |
| **Attachments** | Upload images and files. Use **Select Attachments** to pick several, then **🔗 Copy Link** or **🖨️ Open & Print** them as a shareable page. |
| **SKUs** | Manage the collection's SKUs (shared across the whole collection; saved immediately). |
| **History** | A full audit log of every change — due date, status, assignee, vendor, notes, SKUs — with who made it and when. |

Changing a due date works the same way as in the wizard: if the change would push DDP, you get the **Accept / Proportionally Resize / Keep DDP as-is / Cancel** choice. Click **Save Changes** to commit, or use **Delete task** (bottom-left) to remove it.

> **Edit permissions:** admins and anyone with edit-all can change any task. Others can edit only tasks assigned to them; everyone else sees a **👁 View Only** badge and read-only fields.

### Adding a custom task

From the Timeline, admins click **+ Add Task** to add a phase outside the standard pipeline:

1. Pick the **Collection** and a **Phase / Task Name** (free text).
2. Choose **Position** — before all tasks, after a specific task, or after all tasks. The due date pre-fills accordingly.
3. Fine-tune **Due Date**, **Days Before DDP**, or **Days to Complete** (all three stay in sync), set **Status** and **Assignee**, add **Notes**, and click **Add Task**.

## Filters, favorites, and exports

A **filter bar** sits just under the header on the Dashboard, Timeline, and Calendar. Click **⚙ Filters** and expand any section — **Brand**, **Season**, **Customer**, **Vendor** — to tick the values you want. Active filters show as removable chips, and **✕ Clear All Filters** resets everything. Filters apply across all three views at once.

- **Favorites** — the star icon in the header bookmarks the current view for quick return (shared with the rest of the suite).
- **Focus a collection** — clicking a collection card, or "Open Timeline / Open Calendar," narrows every view to that one collection until you click **✕ Show All**.
- **Exports** — tables across the suite export to branded Excel via the export button where shown.

## Trend Briefs

The **Trend Briefs** view lists monthly, AI-synthesized trend direction for the design team. Each brief is a card showing its month, title, status badge (**draft / published / archived**), and theme count. Tick **Show archived** to include older ones, or **Refresh** to reload.

Click a brief to open a side drawer with its full summary and a list of **themes** — each with a direction dot (rising / peaking / fading), a confidence score, signals, and sources. Use the status buttons in the drawer to move a brief between **draft → published → archived** (for example, publish a brief once it's ready for the team to act on).

> Briefs are generated by the AI pipeline offline; in the app you read them and manage their status. If none exist yet, the view explains how one is produced.

## Ask AI

Click **✨ Ask AI** in the header to open the Claude assistant. Ask it about your design data — "When was the last trend brief published?", "How many tech packs are pending approval?", "Which design concepts have shipped to production?" — and it answers from the live data, never inventing numbers. Sample prompts are offered to get you started.

## Settings — supporting managers (admin)

The **⚙️ Settings** menu in the header opens the master-data managers. Designers see **Team** and **Vendors**; admins see all of them.

| Manager | What it controls |
|---|---|
| **👥 Team** | Team members — name, role, avatar colour. Drives assignee pickers and avatars. |
| **🏭 Vendors** | Each vendor's country, transit days, MOQ, contact, and **category specialties**. Two lead-time tabs — **Design Lead Times** and **Production Lead Times** — set per-phase business days before DDP (a **custom** tag marks where a vendor differs from the template). Vendors can be uploaded from an Excel template, and **Invite to portal** sends a vendor a portal sign-in invite. |
| **🏷️ Brands** | Brands and their colours; flag a brand as private label. |
| **🌿 Seasons** | The season list used throughout. |
| **🏪 Customers** | Customers and their sales channel. |
| **📐 Sizes** | The Size Library and per-gender size sets used on SKUs. |
| **🗂️ Categories** | Product categories and sub-categories. |
| **⚧ Genders** | Genders and the sizes each maps to. |
| **📋 Order Types** | The order-type list (Upfront, Projected, Stock, etc.). |
| **📋 Tasks** | The default task templates — the phase lead times new collections start from. |
| **🎭 Roles** | Team roles (Designer, Product Developer, etc.). |
| **👤 Users** | User accounts and their permissions — who can view all collections, edit all, or edit only their own. |

> **Lead times are business days.** In the vendor and task managers, Mon–Thu count as 1 day, Friday as half a day, and weekends/holidays as 0. This is why pre-production dates land on working days.

## Activity, Teams, and Email

- **📋 Activity** (header) opens the activity log — a running record of changes across collections and tasks.
- **💬 Teams** and **📧 Email** (bottom nav) connect to Microsoft Teams and Outlook so you can message about, or email, a collection's people directly from the calendar. A green **💬 Teams** label by your name shows when a Teams session is connected.

> **Everything saves live.** The Design Calendar writes every change to the shared database immediately and syncs in real time, so teammates see your reschedules and status changes without refreshing. A red toast in the corner warns you if a save ever fails.
