# 42 — Costing Module

The Costing app (`/costing`) builds a price/cost workbook per project: one row per
style/color/vendor, then turns selected rows into vendor RFQs, compares quotes, and
awards the winner.

## Project header (required before rows)

Open a project and fill the header **before adding any costing rows**. These fields
are required — `+ Add row` is blocked with a list of what's missing until they're set:

- Project name, Brand, Gender
- Customer, Sales rep
- Payment terms
- Request date, Due date

> **Payment terms drive the cost mode.** Pick a **DDP** term (any term whose name
> contains "DDP") to switch the grid into DDP costing.

## The costing grid

Each row is a style line. Key columns:

- **Style# / Description / Scale / Fabric / Fit / Color / Closures / Waist** — the spec.
- **Qty** — target units.
- **Vendor** — the intended vendor (used to group RFQs). Pick from the dropdown or add a new one.
- **Avg Cost / PO History** — historical reference. PO History shows the per-unit cost
  from past POs; prepack (PPK) pack prices are **exploded to per-unit** so a pack POs
  don't inflate the figure. A "Pack" column shows the pack size used.

### Cost basis: FOB/Landed vs DDP

The grid has two cost modes, chosen by the project's payment term:

| Mode | Cost columns shown | Cost basis for margin |
|------|--------------------|-----------------------|
| **Non-DDP** (default) | FOB, Duty %, Freight, Insur, Other, **Landed** (computed) — grouped under the **"FOB / Landed Target"** header band | Landed cost |
| **DDP** | **Tgt DDP Cost** only (FOB→Landed columns hidden) | Tgt DDP Cost |

In non-DDP mode, **Landed = FOB + FOB×Duty% + Freight + Insurance + Other**.

### Sell Tgt Frm Mrgn

Between **Tgt DDP Cost** and **Sell Tgt** there's a **Sell Tgt Frm Mrgn** (%) field. Type a
target gross-margin % and the grid **auto-fills Sell Tgt** = `cost basis ÷ (1 − margin/100)`
(holding the cost fixed). You can still **override Sell Tgt** directly afterwards — doing so
**clears the Sell Tgt Frm Mrgn cell** (it goes blank), since the sell price no longer comes
from that margin. This is the inverse of the **Margin %** column below (which back-solves the
*cost* from a margin, holding sell fixed) — use whichever direction you're working in.

### Margin %

**Margin %** auto-fills from the **Sell Tgt** price and the cost basis:

```
Margin % = (Sell Tgt − cost basis) / Sell Tgt × 100
```

(There is no separate "Sell" column — margin and the footer totals use **Sell Tgt**.)

**Margin % is editable.** Type a target margin and the grid back-solves the cost to hit it:

- **DDP mode** → sets **Tgt DDP Cost** = `Sell Tgt × (1 − margin/100)`.
- **Non-DDP mode** → solves **FOB** so that Landed hits the implied cost, holding Duty %,
  Freight, Insurance and Other fixed.

A **Sell Tgt** must be entered first (you can't solve a cost without a selling price).

### LY / T3 comparison

LY (last year) and T3 (trailing 3 months) cost, sales price and margin are pulled from
sales history for the **base style** — both the base style and its PPK variants
contribute, with pack rows exploded to per-unit so prepack pricing doesn't skew the average.

**Single-unit (qty = 1) sales are excluded** from the comp — one-off pieces (samples /
B2C, often priced far above wholesale) aren't representative and were skewing thin windows
(e.g. a color that only sold a handful of single units last year). Pack sales are kept (a
1-pack PPK row explodes to its unit count). If a style/color genuinely had no multi-unit
wholesale sales in a window, that comp shows **—** instead of a misleading number. *(Comp
values are stored per line — use the comp refresh to recompute existing lines.)*

## Incomplete-row guard

A row is **incomplete** if it's missing any of: style, color, vendor, qty, cost
(Tgt DDP Cost or a target/FOB cost), or **Sell Tgt**. Incomplete rows can't be sent.
You'll be warned — with the option to **delete the incomplete rows and continue**, or
**go back and fix** — when you:

- click **Vendor RFQ** (Send) with an incomplete row selected, or
- leave the project (**← Projects** button, or closing the tab).

## RFQ flow

1. Tick rows and click **Vendor RFQ**. This creates one RFQ per vendor **and
   sends it to the vendor in the same step** — there's no separate **Send**
   click anymore. Each vendor is invited and notified (in-app 🔔 + email)
   immediately, and the RFQ shows up in their portal right away. The toast
   confirms "<n> RFQs **sent to vendor**". The vendor then submits a quote.
   - The **target unit price** the vendor sees on each RFQ line matches the
     project's cost basis: **Tgt DDP Cost** for DDP projects, **FOB cost** for
     FOB/Landed projects (never the sell price). Editing the costing line's
     Tgt DDP / FOB cost re-syncs the target on any RFQ already generated.
   - If an RFQ already exists for the same **style / color / vendor**, you're
     asked to confirm before a duplicate is created and sent.
2. In the **RFQ list**, the **Fabric** column shows `CODE — Description`, and clicking a
   row opens that RFQ's **source project in a new tab** (the title cell still opens the
   RFQ editor).
3. **Compare RFQs** lays quotes side-by-side; **Award** picks the winner. Each
   line's **Sell $** reference is the project's **Sell Tgt** (the price you sell
   at — editable inline per line), and per-vendor **margin = (Sell − quoted) ÷
   Sell**. The vendor's own target *cost* (what they quote against) is shown
   separately on the RFQ itself, not in this comparison.

> **Number formatting.** Throughout the module — Compare RFQs and the costing
> grid — unit prices, per-line extended amounts, margins and percentages display
> to **two decimal places**. The roll-up **grand totals** (each vendor's quote
> total, and the grid's footer **Total cost / Total sales**) are shown as **whole
> dollars** with no decimals for readability. Quantities remain whole numbers.

> **Collapsible headers.** Every informational header block — the **project
> Details** card, the **RFQ context** strip, and the **Compare RFQs** project
> summary — has a small **▾ triangle** in its top-right corner. Click it to
> collapse the block down to a one-line summary (and **▸** to expand again),
> reclaiming vertical space while you work the grid below. Your choice is
> remembered per header across reloads.

### ✨ AI cost suggestion (co-pilot)

**Right-click any row** in the costing grid and choose **✨ AI cost suggestion**.
A co-pilot reads everything you'd normally check by hand — the style's **last-year
and trailing-3-month** sales (cost, sell price, margin), the book **avg cost**, and
the real **purchase-order history** across every vendor — and recommends:

- a **cost** (DDP *Target cost* on DDP projects, or *FOB cost* otherwise),
- a **sell target**, and
- the resulting **gross margin %**,

each with a **confidence score**, a plain-English **rationale**, and the **signals**
it used. Nothing is saved until you click **Apply** (apply a single value, or
*Apply cost + sell* for both) — the numbers then flow through the normal line save,
so margin recompute and any RFQ-revision prompts still fire. If a style has no
sales or PO history, the co-pilot says so rather than guessing.

### 📐 AI size curve

Right-click a row and choose **📐 AI size curve** to see how the style's demand
splits **by size**, learned from its own **last-24-months** wholesale sales (pack
sales are exploded to units first). Each size shows its **% of demand** and — when
the row has an order qty — the **suggested units** to buy in that size (rounded so
the split sums exactly to your order quantity, ordered by the assigned size scale).
A short read and a **⚠️ flag** on any size that looks stockout-suppressed (low
because it sold out, not because demand was low) round it out. This is a
**buy-planning guide** and isn't saved to the line (costing lines are color-grain).

### ✨ Ask AI (analytics)

The costing nav bar has an **✨ Ask AI** button that opens the suite's analytics
assistant without leaving the module. Ask it natural-language questions about your
sales, margins, styles and customers and it answers from the live database — e.g.
*"which styles had a gross margin under 18% in the last 3 months?"*,
*"show me my top 10 styles by trailing-3-month sales"*,
*"compare last-year vs trailing-3-month sales for RYB0412"*, or
*"which customers are buying less than they did last year?"*. Starter questions are
shown on first open; click one or type your own.

### When a vendor revises a quote

A vendor can reopen an already-submitted quote and resubmit revised figures. When
they do:

- The procurement team is **notified automatically** — both **in-app** (the 🔔
  bell) and by **email**. The alert is titled "<vendor> revised their quote …
  (v2)" so you can tell it apart from a brand-new quote. Configure recipients via
  `INTERNAL_PROCUREMENT_EMAILS` or per-employee notification subscriptions.
  > **Where the bell lives:** RFQ notifications appear in the **Costing app's**
  > 🔔 bell (RFQs are run from Costing). They no longer pile up on the PLM launcher
  > home screen — open the Costing app to see them.
  **The in-app bell now lights up automatically** whenever a recipient's email
  matches a staff member's **PLM login** (their Teams email on the login roster) —
  no one has to hand-link a PLM login on the Employee record anymore. If a
  recipient's email has no matching PLM login, they still get the **email**; only
  the bell is skipped for them.
- The next time you **open that RFQ**, a banner + toast pop up at the top
  ("⚠ <vendor> revised their quote — review the highlighted rows"). The vendor's
  row in the comparison shows a gold **Revised v2** badge; expand it to see
  **current vs. prior** prices, lead time, and per-line figures.
- Click **Got it** to dismiss the banner. It won't nag you again for that RFQ
  unless the vendor revises *again* (a newer version re-triggers it).

**What the vendor sees:** the vendor gets their own **in-app + email confirmation**
("Your revised quote (v2) was submitted") and, on their RFQ page, a read-only
**🕑 Your revision history** expander listing their prior versions (totals, lead
time, per-line figures). A vendor only ever sees **their own** history — never
another vendor's quotes and never Ring of Fire's internal comparison.

> **Attaching a document also counts as a revision.** If a vendor adds a file to a
> quote they've **already submitted**, the quote is snapshotted and bumped to the
> next version (gold **Revised** badge), and **procurement is notified** the same
> way as a price revision — so a document added after the fact never slips by
> unseen. Attaching a document to a **draft** (not-yet-submitted) quote is normal
> and triggers no revision.

> Note: Ring of Fire staff cannot edit a vendor's **quote** (quotes belong to the
> vendor), and the RFQ header locks once published. But editing a **costing line**
> after its RFQ was sent **does** flow through to the vendor — see below.

### When YOU (Ring of Fire) revise a sent RFQ

If you edit a costing line that's already been sent to a vendor — its **Tgt DDP /
FOB cost**, **Qty**, **fabric**, **size scale**, **style**, **color**, **fit**,
etc. — the change automatically syncs onto that vendor's RFQ line, and:

- The **vendor is notified** — in-app (🔔 bell) + email: *"An RFQ was revised: …"*.
- When the vendor **opens the RFQ**, a popup tells them *"One of your RFQs has been
  revised,"* the changed line shows an **✎ Revised · <date>** badge, and **each
  changed value is shown in green** so they see exactly what moved.
- Only the fields you actually changed are flagged; re-editing re-notifies with the
  new change set.
- **You don't get asked to "send" the revision** — it propagates automatically when
  you save the costing line. Right after saving, you get an **on-screen confirmation**:
  *"RFQ "<title>" revised (target cost, qty) — sent to <vendor>."* If you change a
  field the vendor never sees (e.g. **Sell Tgt** / margin), no revision is sent and
  no confirmation appears — that's expected.
- **Revision history (internal):** open the RFQ from PO-WIP → its detail panel now has
  a **🕑 RFQ revision history (Ring of Fire)** expander listing every buyer revision —
  when, which line, and each field's **old → new** value. This mirrors the vendor's own
  quote-revision history.
- **Attaching a document is a revision too.** Costing-line documents are
  vendor-visible (the vendor reaches them from their RFQ detail), so adding a file
  to a line whose **RFQ was already sent** flags that line **✎ Revised**, records a
  **Documents** entry in the revision history, and **notifies the vendor** — exactly
  like changing a vendor-visible field. Attaching a document to a **draft** line (no
  RFQ sent yet) is normal and triggers no revision or notification.

See also: [14 — Payment Terms](14-payment-terms.md), [15 — Fabric Codes](15-fabric-codes.md),
[32 — Procurement & Receiving](32-procurement-receiving.md).
