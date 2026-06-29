# 4 — Tech Packs

The Tech Packs app is where design and product-development staff build the full specification package for a style — flat sketches, measurement specs, bill of materials, costing, samples, approvals and product images — and then share it with vendors over email or Teams. Everything lives at the **`/techpack`** URL, reachable from the **🧩 Apps** launcher (the **📐 Tech Packs** tile) or directly in your browser.

> **Who this is for:** ROF designers, tech designers, graphic artists and product developers. You sign in once from the PLM launcher; the Tech Packs app reuses that session.

## Opening the app and signing in

1. Open the PLM launcher (the home page) and click the **📐 Tech Packs** card, or navigate straight to `/techpack`.
2. If you are not signed in you'll see a **"Please log in from the PLM launcher"** message with a 📐 icon and a link back to the launcher. Sign in there first, then return.
3. Once signed in you land on the **Dashboard**. Your name and avatar appear at the far right of the top bar.

The top navigation bar always shows these buttons: **Dashboard · All Packs · Libraries · Samples · 💬 Teams · 📧 Email · 🔔 Notifications**, plus your **Favorites** star at the left, your avatar/name, a **← PLM** button (return to the launcher) and **Sign Out**.

> **Note:** Email and Teams sharing each need a separate Microsoft sign-in (one click) the first time you use them in a browser session — see [Sharing a tech pack](#sharing-a-tech-pack-email-and-teams) below. Signing in to the PLM launcher is not the same as connecting Outlook/Teams.

## Dashboard

The Dashboard gives you a one-glance summary of every tech pack.

- **Stat cards** across the top: **Total Packs**, **Draft**, **In Review** and **Approved** — a live count by status.
- **Recent Tech Packs** — the five most recently updated packs. Click any row to open it.
- **Approval Status** — a bar chart of all approval stages across every pack, broken down into Pending / Approved / Rejected / Revision Required.
- **Sample Tracking** — per sample type (Proto, SMS, PP, TOP, Production), how many samples are approved out of the total.

The **+ New Tech Pack** button (top-right of the Dashboard and the All Packs view) opens the create form.

## All Packs

The **All Packs** view lists every tech pack as a card grid. Each card shows the style number, status badge, style name, brand · season and category, plus the last-updated date.

Filter the list with the controls along the top:

| Control | What it does |
|---|---|
| Search box | Matches style name, style number or brand. Filters as you type. |
| **All Statuses** | Draft · In Review · Approved · Revised |
| **All Brands** | Brands found on existing packs |
| **All Seasons** | Seasons found on existing packs |

A live count ("N packs") sits at the end of the filter row. Click any card to open the detail panel.

## Creating a tech pack

1. Click **+ New Tech Pack** (from the Dashboard or All Packs).
2. Fill in the **Create Tech Pack** form:

| Field | Notes |
|---|---|
| **Style Number \*** | Required. E.g. `OXF-001`. |
| **Style Name \*** | Required. E.g. `Classic Oxford Shirt`. |
| **Brand** | Pick from the Design Calendar brand list, or click **+** to add a new brand on the spot. |
| **Season** | Pick from the season list, or **+** to add one (e.g. `Fall 2026`). |
| **Gender** | From the shared gender list. |
| **Vendor** | From the shared vendor list (country shown in parentheses). |
| **Category** / **Sub Category** | Sub Category options appear once you pick a Category. |
| **Tech Designer / Graphic Artist / Product Developer / Designer** | Team-member pickers — choose a person (avatar + role shown) or **— None —**. |
| **Description** | Free text. |

3. The **Create Tech Pack** button stays greyed out until both Style Number and Style Name are filled.
4. On create, the pack opens to its **Spec Sheet** tab so you can start entering measurements.

> Brands and seasons you add with the **+** buttons are saved to the shared Design Calendar reference data, so they appear everywhere that uses those lists.

## The detail panel

Clicking a pack opens a full-screen detail panel. At the top:

- **Style number** and a colour-coded **status badge**.
- **Style name** and the brand · season · category line underneath.
- A **status dropdown** (Draft / In Review / Approved / Revised) — change it here at any time.
- A **🗑️** delete button (asks for confirmation; deleting removes all specs, BOM, samples and approvals) and a **✕** to close.

Below that is an info grid showing **Designer, Division, Owner, Active, Version** and the last-updated date, plus the description if one is set.

> **Auto-save:** every edit you make in the detail panel saves itself automatically about a second and a half after you stop typing. A green **"Saved ✓"** toast confirms it. There is no manual Save button.

The panel is organised into tabs: **Sketch · Spec Sheet · Construction · BOM · Costing · Approvals · Samples · Images**.

> The **Costing** tab is only visible to users whose permission set allows it (granted by default). If you don't see a Costing tab, your account isn't permitted to view costs.

### Sketch tab

Titled **Style Design Detail**. Use this to attach the flat sketch and call out construction points.

1. Upload a **Front View** and **Back View** image — click either dashed tile and choose a file. Click an uploaded image to enlarge it (lightbox); use **Remove** to clear it.
2. **+ Callout** adds an auto-numbered detail line. Type a description next to each numbered marker; the 🗑️ removes a callout.
3. **Stitching Detail** is a free-text box for stitch specs (e.g. `CHAINSTITCH @ INSEAM`, `SPI 8 @ OUTSEAM`).
4. **Measurements based on size** — enter the base sample size (e.g. `32`); it prints as a `*MEASUREMENTS BASED ON SIZE 32` note.

### Spec Sheet tab

Two sections: a **Style Info** block (Designer, Division, Owner, Version, Description, Brand, Season and an **Active** Yes/No toggle) and a **Measurements** grid.

To build the measurement grid:

1. **+ Size Column** — type a size (e.g. `M`) and click **Add**. Repeat for each size. Remove a size with the **✕** in its column header.
2. **+ Measurement** — adds a row. Fill in the **Point of Measure** (e.g. `Chest`), a **Tolerance**, and a value for each size.
3. Delete a row with the **🗑️** in its **Del** column.

> The Spec Sheet tab here is the per-pack measurement grid. There is also a standalone **Spec Sheets library** (under Libraries) with templates and Excel import/export — see [Libraries](#libraries).

### Construction tab

A list of **Construction Details**. Click **+ Add Detail** to add a block, then fill in:

- **Area** (e.g. `Front Body`, `Collar`, `Sleeve`)
- **Detail** (the construction instruction)
- **Notes**
- **Reference Photos** — click the dashed **+** tile to upload one or more photos; click a photo to enlarge, or its corner **✕** to remove it.

The 🗑️ at the top of each block removes the whole detail.

### BOM tab

The **Bill of Materials**. The left columns are fixed (Image, Mat No, Material, Placement, Content, Weight, Qty, UOM, Unit $, Total); colourways add paired columns on the right.

1. **+ Colorway** — name a colourway (e.g. `BLACKSANDS`). Each colourway adds **Color / Pantone** and **Trl / Sz** (trial size) columns and a removable chip above the table.
2. **+ Add Item** — adds a material row. Pick a **Material** from the Materials Library (which auto-fills supplier, unit cost, content and weight), or type a name directly. Fill in **Mat No**, **Placement**, **Content**, **Weight**, **Qty**, **UOM** (YDS, MTR, PCS, KG, LB, DOZ, SET) and **Unit $**.
3. Upload a small swatch/part image per row via the image cell.
4. For each colourway, enter the **Color name**, **Pantone / code** and **trial size**.

**Total** per row and the **Total BOM Cost** in the footer calculate automatically from Qty × Unit $.

### Costing tab

Titled **Costing Breakdown**. Enter the cost inputs on the left and read the results on the right.

| Input | |
|---|---|
| **FOB Price ($)** | The vendor's FOB cost. |
| **Duty Rate (%)** | Duty Amount is computed from this and shown read-only. |
| **Freight ($)** · **Insurance ($)** · **Other Costs ($)** | Landed-cost add-ons. |

The right side shows:

- **Landed Cost** = FOB + Duty + Freight + Insurance + Other (computed).
- **Wholesale Price ($)** and **Retail Price ($)** — you enter these.
- **Margin** — computed and shown as a big percentage with a colour-coded bar (red below ~30%, amber mid-range, green at healthy margins).
- **Costing Notes** — free text.

### Approvals tab

A sequential **Approval Workflow** across five stages: **Design → Merchandising → Buying → Production → Quality**. A progress bar across the top shows each stage's state.

For each stage you can set an **Approver** and **Comments**, then click **Approve**, **Reject** or **Request Revision** (each stamps today's date). **Reset** returns a stage to Pending.

> **Stages unlock left to right.** A stage stays locked (greyed out, "Previous stage must be approved first") until every stage before it is **Approved**.

### Samples tab

**Sample Tracking** for the style. **+ Add Sample** adds a sample block where you set:

- **Type** — Proto, SMS, PP, TOP or Production.
- **Status** — Requested, In Progress, Received, Approved or Rejected. Moving a sample to Received / Approved / Rejected auto-stamps today as the **Receive Date** if it's still blank.
- **Vendor**, **Request Date**, **Receive Date**, **Comments**.
- **Images** — upload sample photos; click to enlarge, **✕** to remove.

### Images tab

**Product Images** — a simple gallery. Click **+ Upload Image** (multiple files at once allowed). Click any image to view it full-size, or use its 🗑️ to delete it.

## Libraries

The **Libraries** view has two tabs: **Materials** and **Spec Sheets**.

### Materials library

A searchable, filterable table of reusable materials (the same list the BOM tab pulls from).

1. **+ Add Material** opens the material form: **Name, Type** (Fabric, Trim, Label, Thread, Zipper, Button, Elastic, Interlining, Packaging, Other), **Composition, Weight, Width, Color, Supplier, Unit Price, MOQ, Lead Time, Certifications** and **Notes**.
2. Filter the table with the search box and the **All Types** dropdown.
3. Each row has **✏️** edit and **🗑️** delete actions.
4. The green **Excel** button downloads the whole materials list as a spreadsheet.

### Spec Sheets library

Standalone spec sheets (independent of any single tech pack), useful as reusable measurement specs and for round-tripping with vendors via Excel.

- **Search spec sheets…** filters the card grid (each card shows style number, style name, brand · season, category and POM count).
- **Templates ▾** opens the **Spec Sheet Templates** gallery (see below).
- **+ Add / Import ▾** offers two choices:
  - **Add New Spec Sheet** — opens the **New Spec Sheet** form (Style Name required, plus Style Number, Brand, Season, Category/Sub-Category, Gender, Vendor, Description and **Sizes**). Pick a size scale with the preset buttons (**XS–XXL**, **28–40 (even)**, **28–48 (all)**, **0–16 (kids)**) or type a custom comma-separated list.
  - **Import from Excel** — upload an `.xlsx` (or `.csv`) and the app detects the header row, sizes and measurement rows and builds a sheet for you. It also tries to read the style name/number/brand/season from the file.
- Each card has a green **Excel** download button, **✏️** edit (opens the detail) and **🗑️** delete.

#### Spec sheet detail

Opening a spec sheet shows a **Style Info** form (Style Name, Style Number, Brand, Season, Category, Sub-Category, Gender, Vendor, Description and **Sizes** with the same preset buttons) over a **Measurements** grid.

- **+ Size Column** adds a size; **✕** in a header removes it.
- **+ Section** inserts a labelled section header row (e.g. "Waist / Rise") to group measurements.
- **+ Measurement** adds a Point-of-Measure row with a Tolerance and a value per size.
- The green **Excel** button (top-right) downloads the sheet; **📤 Upload Excel** re-imports measurements from a spreadsheet.

#### Templates

The **Templates ▾** gallery shows **Built-in** templates (such as **Men's Jeans** — 24 POMs across Waist/Rise, Hip/Thigh, Inseam/Leg, Waistband, Front Pockets and Back Pockets/Yoke) alongside any you upload. Each template card lists its category, POM count and size summary.

- **Use Template** pre-fills the New Spec Sheet form with the template's measurements, so creating the sheet clones every POM row.
- The green Excel button downloads a **blank** version of the template (rows with empty values) to send to a vendor.
- **Upload Template** (top of the gallery) imports an `.xlsx` as a new reusable template.
- Built-in templates can't be deleted; your own uploaded templates show a 🗑️.

## Samples (overview)

The top-nav **Samples** view is an **All Samples** table flattening every sample across every tech pack, with columns: Style #, Style Name, Type, Status, Vendor, Requested and Received. It's a read-only roll-up — to edit a sample, open its tech pack's Samples tab.

## Excel export and import

Tech Packs uses Excel (`.xlsx`) for sharing measurement data with vendors and factories:

- **Spec sheets** — download from a spec-sheet card, from the spec-sheet detail, or as a blank template from the Templates gallery. Re-import an edited file via **📤 Upload Excel** or **Import from Excel**.
- **Materials** — the **Excel** button on the Materials library exports the full list.

Downloaded files carry the Ring of Fire branding. There is no PDF export at this time — share specs as Excel, or email the tech pack (below).

## Sharing a tech pack: Email and Teams

Both the **📧 Email** and **💬 Teams** views connect to your Microsoft 365 account so you can correspond with vendors about a specific style without leaving the app. The first time you open either view in a browser session, click **Sign in with Microsoft** and complete the popup. Once connected you'll see a green **● Live** / **✓ Connected** indicator and can **Sign out** from the same spot.

> Email and Teams group every message for a style under a tracking tag — `[TP-<style number>]` — added to the subject line. Keep that tag in the subject and replies stay grouped with the right tech pack.

### Email view

A three-pane Outlook-style layout:

1. **Left sidebar** — a **✎ New Message** button, a searchable list of your tech packs, and **Inbox / Sent** folders. Select a tech pack first; the app loads the messages tagged for that style.
2. **Middle list** — the selected folder's messages, with **All / Unread / Flagged** filter pills and a search box. Unread messages show a dot; click one to open it (it's marked read). Right-click a message for **Reply / Reply All / Delete**.
3. **Right pane** — the full conversation thread (collapsing older messages), any **📎 Attachments** (downloadable), and a reply box. Use the **★** to flag and the **🗑️** to delete a message (with a confirm bar).

**Composing:** click **✎ New Message** (with a tech pack selected, the subject is pre-filled with the `[TP-…]` tag). Fill in **To** (comma-separated addresses), **Subject** and **Body**, then **Send ↗**.

### Teams view

Lets you start a Teams conversation per tech pack, or message a colleague directly.

- **TP Channels** tab — pick a tech pack and the app finds or creates a Teams channel for it under the RING OF FIRE team, then shows the channel messages. A status chip shows **ACTIVE** (channel exists) or **NO CHAT**, plus an unread/message count. Type at the bottom to post.
- **Direct Message** tab — type a recipient and a message to start a one-to-one chat, then continue the conversation inline. Use **✎ New** to start a fresh DM.

## Notifications

The **🔔 Notifications** button (with an unread badge) opens this app's notification inbox, filtered to Tech Pack events. A small notification bell also surfaces new items elsewhere in the app.

## Tips and gotchas

- **Nothing to save manually.** The detail panel auto-saves; libraries and spec sheets save when you add/edit/delete (a toast confirms each save).
- **Costing tab missing?** It's permission-gated — ask an admin to grant Costing access.
- **Brand/season not in the list?** Use the **+** buttons in the create form to add one; it's shared back to Design Calendar.
- **Email/Teams says "Sign in"?** That's a separate Microsoft connection from your PLM login — click **Sign in with Microsoft** once per browser session. If you see "Azure credentials not configured", the Microsoft integration isn't set up in your environment yet.
- **Approvals locked?** Stages open one at a time — approve the earlier stage first.
- **Keep the `[TP-…]` subject tag** on emails so replies stay attached to the right style.
