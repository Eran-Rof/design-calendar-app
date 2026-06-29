# 8 — GS1 Prepack Labels

This chapter covers the **GS1 Prepack Labels** app — the tool ROF warehouse and ops staff use to turn a packing list into scannable barcode labels for apparel prepacks, generate carton shipping labels, and receive cartons back in by scanning. Open it at **`/gs1`**, or from any other app's **Apps** launcher (it appears as **🏷️ Prepack Labels** / **Labels**).

## What this app is for

When ROF ships apparel in **prepacks** — a single carton or polybag that holds a fixed mix of sizes for one style and color — every pack and every carton needs a barcode the retailer (and our own warehouse) can scan. This app produces two kinds of GS1 barcodes:

| Barcode | Identifies | Length | Where it goes |
|---|---|---|---|
| **GTIN-14** (Pack GTIN) | A **style + color + scale pack** (a product type) | 14 digits | One label per pack |
| **SSCC-18** | A **physical carton** (a shipping unit) | 18 digits | One label per carton |

The key difference: the **same** style/color/scale pack always carries the **same** GTIN, but **every carton** gets its own unique, never-reused SSCC serial number.

> **The prepack matrix concept.** A "pack" is not a single garment — it's a bundle defined by a **scale**. For example a scale might be "1 Small, 2 Medium, 2 Large, 1 XL" = 6 units per pack. The app's job is to know, for each pack, exactly which child UPCs (the individual size barcodes) are inside and in what quantity. That mapping — pack GTIN → child UPCs × quantity — is called the **BOM** (bill of materials). The BOM is what makes one-scan receiving possible: scan the carton, and the app explodes it down to every size and unit inside.

## The tabs

The app has a single top navigation bar with these tabs, left to right:

1. **Company Setup** — your GS1 prefix and the numbering counters.
2. **UPC Master** — the child (size-level) UPCs.
3. **Scale Master** — pack scale codes and their size ratios.
4. **Pack GTINs** — one GTIN per style/color/scale, plus BOM build.
5. **Styles Catalog** — the publishable supplier catalog: auto-import styles & colors, set sales prices, publish a GDSN / retail-portal feed.
6. **Packing List** — upload a packing list and parse it.
7. **PA Unpacker** — a standalone tool for Macy's Pack Assortment files.
8. **Label Batches** — create and print/export label runs.
9. **Label Templates** — label layouts (size, printer, what prints).
10. **Carton Labels** — generate a single carton SSCC by hand.
11. **Receiving** — scan a carton in and confirm what arrived.
12. **Exceptions** — data quality checks and the audit trail.
13. **Workflow Guide** — a read-only reference of the standard GS1 → EDI retail flow.

A **🔔 Notifications** button sits on the right of the bar. There is also a **Favorites** menu and the suite-wide ⌘K / Ctrl-K search palette.

## The end-to-end flow

For most jobs you move through the tabs in order:

```
Company Setup → (UPC Master) → Scale Master → Packing List
   → Generate GTINs → Build BOMs → Label Batches → Print / Export
```

Receiving and the Carton Labels tab are used later, when cartons ship and come back.

---

## 8.1 Company Setup (do this first, once)

Everything else depends on Company Setup being saved. Open the tab and fill the four sections.

**Company Information**

1. **Legal Company Name** — your registered company name.

**GS1 GTIN Numbering**

2. **GS1 Company Prefix** — the numeric prefix GS1 assigned to ROF (e.g. `0310927`). Digits only.
3. **Prefix Length** — the digit count of that prefix (must match exactly).
4. **GTIN Indicator Digit** — usually `1`; varies by product type.
5. **Starting Item Reference** — the first reference number to use. This is the part *you* control, excluding the prefix and check digit.
6. **Next Item Reference Counter** — the current counter; the app auto-increments it on each new GTIN.

As you type, a green **Preview GTIN for current counter** box shows exactly what the next GTIN will look like. If a value is out of range, the box turns red and explains why.

**GS1 SSCC Numbering**

7. **SSCC Extension Digit** — usually `0`; identifies the shipping company.
8. **Starting Serial Reference** and **Next Serial Reference Counter** — the same idea as item references, but for carton serials. A **Preview SSCC** box shows the next carton number prefixed with `(00)`.

**Label Output**

9. **Default Label Format** — a free-text hint such as `4x6_PDF`.

**Xoro API (Optional)** — tick **Enable Xoro Sync** and fill the Base URL, Item Endpoint, and API Key if you want to pull child UPCs straight from Xoro instead of importing Excel (see 8.2).

Click **Save Settings**. A green **✓ Saved** appears.

> The item-reference and serial-reference counters move forward automatically and are never reused. You normally never touch them again after the first save.

---

## 8.2 UPC Master — the child (size-level) UPCs

This tab holds one row per **style / color / size**, each with its own UPC. These child UPCs are what BOMs and receiving explode down to. You get UPCs in here two ways.

### Import from Excel / CSV

1. Click **Choose file** and pick a `.xlsx`, `.xls`, or `.csv` file.
2. A **Column Mapping** row appears — confirm which spreadsheet column feeds **UPC, Style No, Color, Size, Description**.
3. A **Preview** shows the first rows it will import.
4. Click **Import N rows**. Rows missing a UPC or Style No are skipped automatically.

### Sync from Xoro

If Xoro sync is configured in Company Setup, the **Sync from Xoro** card lets you:

- **Test Connection** — confirms the app can reach Xoro.
- **Sync UPCs from Xoro** — pulls the item master. It **upserts by UPC**, so your Excel-imported rows are preserved unless a Xoro record overwrites them.

The card shows the last sync result (processed / inserted / updated) and a collapsible **Sync history**.

> **Duplicate warning.** If the same style/color/size ever maps to more than one UPC, a red **⚠ N duplicate UPC conflicts** banner appears at the top. BOMs are unreliable until you resolve these — delete the wrong UPC using the **✕** in the row's Actions column.

The **UPC Records** list at the bottom is searchable (style / color / UPC / size) and shows a **Source** badge (`xoro` vs imported). Use the columns button to show or hide columns.

---

## 8.3 Scale Master — defining the pack mix

A **scale** is the recipe for a pack: which sizes, and how many of each. Scale codes (e.g. `CA`, `CB`, `CD`) are short codes that also appear on packing lists.

### Adding a scale

1. In **Add Scale Code**, either pick a known code from the dropdown or type a custom code (up to 4 characters).
2. Click **Add & Configure**. A modal opens.
3. In **Size Ratios**, enter each size and its **Qty per Pack** (e.g. `S` × 1, `M` × 2, `L` × 2, `XL` × 1). Leave unused rows blank.
4. The modal shows the running **Total units per pack** as you type.
5. Click **Save**.

The scale list shows each code's description, **Total Units**, and its size ratios (e.g. `S×1, M×2, L×2, XL×1`). Use **Edit** to change ratios or **Delete** to remove a scale (blocked from real harm if GTINs reference it).

### UPC Coverage Check

Before you build BOMs, you can confirm UPC Master actually has a barcode for every size in a scale:

1. In **UPC Coverage Check**, enter a **Style No** and **Color**, and pick a **Scale Code**.
2. Click **Check Coverage**.

The result table lists each size in the scale with its qty, the matched UPC, and a **✓ found** / **✗ missing** status. Missing sizes are highlighted red. A green **✓ Complete** header means you're ready to build a BOM for that pack.

---

## 8.4 Packing List — upload and parse

This is where most jobs start. Upload the order's packing list and the app extracts the rows it needs.

1. In **Upload New Packing List**, choose a `.xlsx` or `.xls` file. Multiple worksheets and block-style layouts are supported.
2. The app parses it ("Parsing workbook…") and shows a result card with the file name, a status badge, and a summary: **sheets · rows · total labels**.

The parser pulls out, per row: **Style No, Color, Channel, Scale, Qty (labels)**, plus a **Confidence** badge (green ≥ 70%, amber ≥ 40%, red below). Rows are grouped by worksheet so you can sanity-check them.

> **Parse issues.** If any block fails, a red **⚠ N parse errors** banner appears and a **Parse Issues** list shows each warning/error with its severity and sheet. Fix the source file and re-upload if errors block the rows you need.

Once rows are parsed, three action buttons appear on the result card — run them in order:

1. **Generate GTINs for All Parsed Rows** — creates (or reuses) a Pack GTIN for every unique style/color/scale found.
2. **Build BOMs from Scale + UPC Master** — fills in each pack's child-UPC list using Scale Master ratios and UPC Master. Enabled only after step 1.
3. **→ Create Label Batch** — jumps you to the Label Batches tab.

The **Upload History** table at the bottom lets you re-open any earlier upload by clicking its row or **View**.

---

## 8.5 Pack GTINs — GTINs and BOMs

This tab is the master list of Pack GTINs (one per **Style + Color + Scale**) and where you build and inspect BOMs. It populates as you generate GTINs from packing lists, but you can also work here directly.

### Create or look up a GTIN by hand

In **Create / Look Up GTIN Manually**, enter **Style No**, **Color**, and a **Scale Code**, then click **Get or Create GTIN**. If a GTIN already exists for that combination it's returned; otherwise a new one is minted from your counter. (Company Setup must be saved first.)

### Reading the list

Each row shows the **Pack GTIN** plus its **Units/Pack**, **BOM Status**, **Missing UPCs** count, **Last Built** date, and **Status**.

**BOM Status** badges:

| Badge | Meaning |
|---|---|
| **not built** | No BOM has been attempted yet. |
| **complete** | Every size in the scale maps to a child UPC. Ready for labels and receiving. |
| **incomplete** | One or more sizes have no matching UPC. **Cannot be used for label export.** |
| **error** | The build failed. |

> A red **⚠ N incomplete BOMs** banner warns when packs are missing UPC mappings. Fix the gaps in UPC Master or Scale Master, then rebuild.

### Building BOMs

- **Build BOM** (or **Rebuild**) on a single row builds that pack's child-UPC list from Scale Master ratios + UPC Master.
- **Build All Missing BOMs (N)** builds every pack that is `not built` or `error` in one pass, reporting how many came back complete / incomplete / error.
- **View** opens a drawer showing the pack's **Child UPCs** (size, UPC, qty per pack) and any **Build Issues**.

Use the **Style / Color / Scale** filter boxes and **Search** to narrow large lists, and the columns button to show/hide columns.

---

## 8.6 Label Batches — printing and exporting

A **batch** is a printable run created from a parsed packing list. Make sure the upload you want is selected (on the Packing List tab) before you start.

### Create a batch

In **Create Batch from Current Upload**:

1. Choose a **Label Type**:
   - **GTIN Only** — one GTIN label per pack (label quantity comes from the packing list).
   - **SSCC Only** — one SSCC carton label per physical carton.
   - **GTIN + SSCC** — both.
2. (For SSCC and Both, the app notes that carton SSCC numbers will be generated and reserved automatically.)
3. Confirm or edit the auto-filled **Batch Name**.
4. Click **Create Batch**.

> A **⚠ batch lines with label_qty ≤ 0** warning appears if any line has a zero or negative quantity. Those lines are skipped on export — fix the source packing list and regenerate.

### Review and export

Select the batch on the left to see its detail on the right: a header with the mode badge, line count, **GTINs**, total **labels**, and (for SSCC modes) **cartons**. The lines table lists each style/color/scale with its Pack GTIN, channel, carton count, and (for SSCC) the **SSCC First** / **SSCC Last** range.

Before exporting you can pick a **GTIN Label Template** and/or **SSCC Label Template** (see 8.7). If none are configured, built-in defaults are used.

Three export buttons:

| Button | Output | Use it for |
|---|---|---|
| **Print PDF** | Opens a browser print window with 4×6 labels | Printing to any normal printer / saving as PDF |
| **↓ Download ZPL** | A `.zpl` file | Sending straight to a Zebra label printer |
| **↓ Download CSV** | A `.csv` file | Loading into BarTender / other label software |

When you first export, the batch is automatically marked **printed** (you can also click **Mark Printed**). Every export is checked first — if a GTIN or carton fails validation, a red **Print validation failed** box lists the problems and nothing prints.

### Reprints

Click **↺ Reprint…** to re-run an export, choose the output method, and optionally record a **Reason** (e.g. "labels damaged"). Reprints are logged separately. The collapsible **Print History** at the bottom lists every print/reprint event with date, type, method, label count, status, and reason.

---

## 8.7 Label Templates

Templates control how a label looks and what prints on it. There are two kinds — **Pack GTIN** and **SSCC Carton** — and one of each can be marked **default**.

- If the list is empty, click **Create Defaults** for sensible starting points, then customize.
- **+ New Template** opens a form: **Template Name**, **Label Width/Height** (inches), **Output Type** (PDF / Zebra ZPL / CSV), **Barcode Format**, and a set of **Human-Readable Fields to Show** checkboxes.
  - GTIN labels can show: Style No, Color, Scale, Channel.
  - SSCC labels can show: Style No, Color, PO Number, Carton #, Total Units.
- **Set Default** marks a template as the one used automatically in Label Batches. **Edit** and **Delete** manage existing templates.

> If you ever see a yellow **Migration required** note here, the label-template feature hasn't been switched on yet for this environment — pass that on to the technical team; the batch screen still works on built-in defaults in the meantime.

---

## 8.8 Carton Labels — one SSCC at a time

Use this tab when you need an SSCC for a single carton outside of a batch (e.g. a one-off or a manually packed carton).

1. Optionally pick a **Packing List Upload** to associate.
2. Fill any of **PO Number, Carton No, Style No, Color, Channel, Total Packs, Total Units**.
3. Click **Create Carton & Generate SSCC**.

The generated SSCC is shown large, both raw and in `(00)` scan format, and stored. The serial counter moves forward automatically. The **Recent Cartons** list shows every carton with its status (generated / shipped / received / cancelled) and an **↓ Export All CSV** button.

---

## 8.9 Receiving — scanning cartons back in

When cartons arrive, use this tab to confirm what's inside by scanning the SSCC.

1. Click into the search box (it auto-focuses) and **scan or type the SSCC-18**. Both the raw 18 digits and the `(00)…` form are accepted.
2. Press **Search**.

The app looks up the carton and shows:

- **Carton Info** (left) — SSCC, status, PO, carton no, channel, style, color, scale, total packs/units.
- **Pack Contents** — the pack GTINs in the carton and their pack counts.
- **UPC Receiving Lines** (right) — the BOM exploded to every **size / UPC**, with **Expected** quantity pre-filled.

### Confirming receipt

3. Adjust the **Received** quantity on any line where what arrived differs from expected. The **Variance** column updates live (green `0` = match), and the totals footer shows expected vs received.
4. Optionally add **Notes** (e.g. "Short ship on size M").
5. Click **Confirm Receive**.

If everything matches, the session is marked **received**. If any line differs, a **⚠ Variance will be recorded** note shows and the session is saved as **variance** for follow-up.

> **Missing BOM.** If a pack in the carton has no BOM, a yellow warning lists the affected GTINs and offers a **Build BOM now** button (it uses Scale Master + UPC Master), after which the carton re-explodes to UPC level.

> **Already received.** Scanning a carton that was already received shows an amber **⚠ Already received** warning; duplicate receiving is blocked.

The **Receiving History** at the bottom lists past sessions with SSCC, status, notes, and received time. **Refresh** reloads it.

---

## 8.10 PA Unpacker (Macy's Pack Assortment files)

This is a **standalone analysis tool**, separate from the GTIN/label flow. Drop one or more Macy's **PA (Pack Assortment)** Excel files and the app computes units by **Style / Color / Size / Channel / IN-DC date** entirely in your browser — nothing is saved to the database.

1. Drag files onto the drop zone (or click to choose). Multiple `.xls`/`.xlsx` files are supported.
2. Each file shows a status (Parsing / OK / Error), sheet and record counts, and a **Verify** check.

> **Verification banner.** Every parse is double-checked silently across three independent layers, and the result shows as a banner:
> - **Channel totals** — units summed per channel tie out to the PA-reported TOTALS row.
> - **Line rows** — units summed per source row tie out to that row's **TOTAL UNITS** column.
> - **Color coverage** — every color in the sheet produces its own records (so a color can't be silently merged into the one above it).
>
> A green banner confirms all three layers reconciled (it shows the count of colors, line rows and channel totals checked). A red banner lists any failed check — **do not trust the numbers until it's green.** The color-coverage layer specifically guards against a color that starts on the sheet's last data row being folded into the color above it.

Three views toggle the layout:

- **Size Matrix** — rows of Style × Color × Channel × delivery date, columns per size, plus an all-channels subtotal block.
- **Pivot** — Style × Color × Size rows, columns per delivery × channel, with a grand-total row.
- **Flat Table** — every record, filterable and sortable; show/hide columns with the columns button.

Click **⬇ Download Excel** to export the combined data.

---

## 8.11 Exceptions & Audit Trail

This tab is your data-quality dashboard and a full log of what's happened in the app.

Click **Run Data Quality Checks** to scan everything in memory. Issues are grouped into cards, sorted errors-first:

| Group | Severity | What it flags |
|---|---|---|
| Incomplete BOMs | error | Pack GTINs missing UPC references |
| Invalid GTIN lengths | error | GTINs that aren't exactly 14 digits |
| Duplicate UPCs | error | Same style/color/size with multiple UPCs |
| Invalid SSCC lengths | error | Carton SSCCs that aren't exactly 18 digits |
| Missing BOMs | warning | Pack GTINs with no BOM built |
| Empty Scales | warning | Scale codes with no size ratios |
| Cartons Without GTIN | warning | Generated cartons missing a pack GTIN |
| Zero-Qty Batch Lines | warning | Batch lines with label quantity ≤ 0 |
| Receiving Variances | warning | Receiving sessions with quantity mismatches |

Summary tiles count open **Errors** and **Warnings**. Expand a card to see the individual issues; each card has a **View records** button that jumps to the relevant tab. Enter an optional resolution note and click **Resolve All** to clear a group.

Three sub-views run across the top: **Open Issues**, **Resolved**, and **Audit Log**. The **Audit Log** records actions like GTIN creation, label prints, and receiving — with time, entity, action, and details.

---

## 8.13 Styles Catalog — the publishable supplier catalog

The **Styles Catalog** is the first step of the standard retail workflow (see 8.14): before a retailer can send you an order, you publish a catalog of your styles, their barcodes, and their prices so the retailer can load them. This tab builds that catalog from data you already keep in Tangerine — you don't re-key anything.

### Build the catalog

You choose **which** styles and colors to include first, then import pulls the price for just those.

1. **Pick a price list.** The **Price list** dropdown lists every Tangerine price list (the M43 pricing lists — Default, per-tier, per-customer, per-brand). Whichever you choose supplies the **sales price** on import. Each option shows its code, name, how many styles it prices, and currency.
2. Click **＋ Add styles & colors.** A picker opens listing every style from the PLM, each expandable to its colors:
   - **Search** by style number, name, brand, or color to narrow the list.
   - Tick a **style** to select all its colors, or expand it (▸) and tick individual **colors**. A green ● on a color means it already has a pack GTIN; a ✓ means it's already in the catalog (re-adding just refreshes its price).
   - **Hide already in catalog** filters out colors you've added before; **Select all shown** / **Clear** act on the filtered list.
3. Click **Import N → pull prices.** The app adds just the selected style/color rows, attaches each style's price from the chosen list, and looks up the pack GTIN already minted for that style/color (from **Pack GTINs**).
4. A green banner reports the result, e.g. *"Added 24 style/color rows — 20 priced from the list, 4 with no list price, 12 already have a pack GTIN."*

> Re-adding a style+color is safe and is how you refresh prices. Rows are keyed on **style + color**, so importing the same one again updates it in place — it never creates duplicates. Switch to a different price list and re-add to re-price.

### Adjust prices before publishing

The grid has one row per **style + color**, showing Style No, Style Name, Color, Brand, Pack GTIN, **Price**, and **Status**.

- **Edit a price** directly in the **Price** cell (enter dollars, e.g. `24.50`) and press Enter or click away — it saves immediately. This overrides the price pulled from the list for that row, without changing the price list itself.
- A **Pack GTIN** of **—** means no GTIN has been minted for that style/color yet. Mint it in **Pack GTINs** (8.5), then re-import. Rows without a GTIN are skipped on the GDSN export.
- Set each row's **Status** — **Draft** (still being prepared), **Ready** (priced and checked), or **Published** (sent to the data pool).
- Use the **search box** (style / color / brand / GTIN) and the **status filter** to narrow large catalogs. Tick the checkbox on rows to act on just those; with nothing ticked, the export/publish buttons act on all rows currently shown.

### Publish the catalog (GDSN / retail-portal feed)

| Button | Output | Use it for |
|---|---|---|
| **⬇ Export CSV** | A `.csv` of the catalog (GTIN, style, color, brand, price, status) | Loading into a retail portal or sharing with a partner |
| **⬇ Export GDSN (XML)** | A GS1 **CIN** (Catalogue Item Notification) payload — one trade item per pack GTIN with its price | Submitting to your GDSN data pool |
| **Publish** | Marks the selected (or all shown) rows **Published** and stamps the date | Recording that the catalog has gone out |

> **Connecting to a live data pool.** The GDSN export produces the *submission payload* you hand to a data pool such as **1WorldSync** or **GS1 Canada**. Actually transmitting to the pool needs that provider's account, your GLN, and transport credentials — those are set up with the data pool, not in this app. Generate the XML here, then upload it through your data pool's portal/connection.

---

## 8.14 Workflow Guide — the standard GS1 → EDI flow

A read-only reference tab explaining how your GS1 codes move between you and a retail partner. The prices and barcodes you manage in the Styles Catalog (8.13) and Pack GTINs (8.5) are what every document below references — keep them consistent end to end.

1. **Catalog** — you publish your style catalog via GDSN or a retail portal (this is the Styles Catalog tab).
2. **Download** — the retailer imports your catalog to load the correct barcodes (UPC / EAN / GTIN).
3. **EDI 850** — the retailer sends a Purchase Order using the exact barcodes they downloaded.
4. **EDI 856** — you ship and send an Advance Shipping Notice (ASN) matching those codes (built from your packing list and carton SSCCs).
5. **EDI 810** — you send the Invoice for final payment.

The tab also includes notes on mapping GS1 attributes for apparel (per-variant GTINs, prepacks/pack GTINs, and publishing the catalog before the first order).

---

## 8.15 Quick reference — common jobs

| I want to… | Do this |
|---|---|
| Set up the app for the first time | **Company Setup** → fill prefix, GTIN and SSCC numbering → Save |
| Load size barcodes | **UPC Master** → Import Excel or Sync from Xoro |
| Define a pack's size mix | **Scale Master** → Add Scale Code → enter size ratios |
| Publish a catalog to a retailer | **Styles Catalog** → pick price list → ＋ Add styles & colors (select) → Import → adjust prices → Export GDSN (XML) / CSV → Publish |
| Turn a packing list into labels | **Packing List** → upload → Generate GTINs → Build BOMs → Create Label Batch → Print/Export |
| Check a pack has all its barcodes | **Scale Master** → UPC Coverage Check, or **Pack GTINs** → BOM Status |
| Print one carton's SSCC | **Carton Labels** → fill form → Create Carton & Generate SSCC |
| Receive a carton | **Receiving** → scan SSCC → adjust received qtys → Confirm Receive |
| Analyse a Macy's PA file | **PA Unpacker** → drop the file → review matrix/pivot |
| Find and fix data problems | **Exceptions** → Run Data Quality Checks |

> **Tip:** GTINs and SSCCs are issued from counters that only move forward and never reuse a number. You don't need to manage the counters by hand — just keep Company Setup saved and let the app increment them.
