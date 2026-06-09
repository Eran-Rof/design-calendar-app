# 9 — B2B Wholesale Portal

The B2B Wholesale Portal is Ring of Fire's self-service storefront for wholesale buyers. It lives at the web address ending in **`/b2b`** and is a completely separate app from the internal staff tools — it has its own sign-in, its own clean light-themed storefront look, and shows each buyer only their own pricing, orders, and account balance.

This chapter is written for two audiences:

- **Wholesale buyers** — people at a customer company who sign in to browse the catalog, build an order, and check their account. See [§9.1](#91-for-wholesale-buyers-getting-started) onward.
- **Ring of Fire staff** — the rep or admin who authorizes buyers, sets prices, and adds product images so the portal goes live. See [§9.8](#98-for-ring-of-fire-staff-setting-the-portal-up) onward.

> The portal does **nothing** until a Ring of Fire admin has set it up — authorized at least one buyer and entered wholesale prices. If you are a buyer and can't sign in, or the catalog looks empty, contact your Ring of Fire sales rep. The setup steps are in [§9.8](#98-for-ring-of-fire-staff-setting-the-portal-up).

---

## 9.1 For wholesale buyers: getting started

Open your browser to the address your rep gave you — it ends in **`/b2b`**. You'll see a sign-in card headed **Ring of Fire — Wholesale Portal**.

There is **no password**. Signing in works by email:

1. Type your work email into the **Email** box.
2. Click **Send sign-in link**. The button briefly shows "Sending…".
3. The card switches to "**Check your email**" and tells you which address the link went to.
4. Open your email **on the same device/browser** and click the secure sign-in link.
5. The link returns you to the portal, you'll see "Signing you in…" for a moment, and then the storefront opens.

If you typed the wrong address, click **Use a different email** to start over.

> **Why a link instead of a password?** The portal sends a one-time "magic link" so you never have to remember a password. The link is good for that one sign-in. If it expires before you click it, just request another from the sign-in screen.

### "Not authorized" message

If you sign in successfully but see **Not authorized — "Your email isn't authorized for the portal yet"**, your email address hasn't been added by Ring of Fire yet, or your account was switched off. Click **Back to sign in** and contact your Ring of Fire sales rep to be set up.

### "Portal unavailable"

This means the portal itself isn't configured on Ring of Fire's side. Contact your rep — there's nothing you can do from the sign-in screen.

---

## 9.2 Finding your way around

Once signed in, the top bar shows **Ring of Fire**, your **company name**, and on the right your **buyer name** and a **Logout** button. Just below is a row of three tabs:

| Tab | What it's for |
|---|---|
| **Catalog** | Browse styles, see your wholesale price, add items to your cart |
| **Orders** | Review your cart, submit an order, and see your order history |
| **Account** | See your open balance and your invoices |

Your cart stays with you as you move between tabs — switching to Account and back to Catalog never loses what you've added. When your cart has anything in it, a red **🛒 cart chip** appears in the top bar showing total units and a running dollar total; clicking it jumps straight to the **Orders** tab. The **Orders** tab also shows a small red count badge of how many units are waiting in your cart.

---

## 9.3 Browsing the catalog

The **Catalog** tab shows your available styles as a grid of cards. Each card has an image area, the style code and name, its brand / gender / category, and the price.

### Filtering and sorting

A toolbar across the top lets you narrow the list:

1. **Search styles…** — type any part of a style code or name; the list refreshes automatically a fraction of a second after you stop typing (no Search button needed).
2. **All brands** — pick a brand to show only that brand's styles.
3. **All genders** — filter by gender.
4. **All categories** — filter by product category.
5. **Sort** — choose **Style code**, **Name**, **Price ↑** (low to high), or **Price ↓** (high to low).

A line above the grid shows the **result count** (for example, "42 styles") so you always know how much you're looking at. If nothing matches, you'll see "No styles match your filters." — widen your search or clear a filter.

### What the prices mean

Every price on a card is **your** wholesale price as set up for your account. Prices are calculated by Ring of Fire's servers for your account specifically — no other customer's pricing is ever shown to you.

- A card with a price shows a **dollar amount**, a quantity box, and an **Add** button.
- If a style has no price set for your account, the card shows **Call for price** and has **no Add button** — you can't order it through the portal. Contact your rep to order those items.
- Some styles have a **minimum order quantity** ("min 12"). The quantity box starts at that minimum and won't let you order fewer.

---

## 9.4 Adding to your cart

On any priced card:

1. Set the **quantity** in the small number box (it starts at the style's minimum).
2. Click **Add**.

The item is added to your cart and the **🛒 cart chip** in the top bar updates. Adding the same style again **adds to** the quantity already in your cart rather than creating a duplicate line. To review or change what you've added, go to the **Orders** tab (or click the cart chip).

---

## 9.5 Reviewing and submitting an order

The **Orders** tab has two sections: **Your cart** at the top and **Your orders** (history) below.

### Your cart

The cart lists each style with its **Unit** price, an editable **Qty** box, the **Line total**, and a **Remove** link. Editing a quantity to **0** removes that line. There's a running **Total** at the bottom.

Before submitting you can set two optional details:

- **Ship to** — pick one of your company's saved shipping locations. If your account has a default location it's pre-selected; otherwise it's "(no specific location)". The list of locations is set up by Ring of Fire.
- **Notes (optional)** — a free-text box for a PO number or special instructions.

To place the order:

1. Review quantities and totals.
2. Choose a **Ship to** location and add **Notes** if you want.
3. Click **Submit order**.

You'll see a green confirmation — "Order submitted… Your rep will review it shortly." — and your cart clears. Your new order appears in **Your orders** below.

> **What happens next?** A submitted order becomes a **draft order** that goes into Ring of Fire's internal sales queue for a rep to review and confirm. It is not a final, priced confirmation until your rep processes it. Prices on your order are re-confirmed at current rates by Ring of Fire when the order is placed (the prices you saw while shopping are your guide).

- **Clear** empties the cart without submitting.
- If your account is set to **browse only**, the **Submit order** button is greyed out and a note explains: "Your account can browse and build orders, but submitting is disabled. Contact your rep." You can still build a cart for a colleague with ordering rights to submit.

---

## 9.6 Order history and reordering

The **Your orders** section lists your orders newest-first, each showing:

| Column | Meaning |
|---|---|
| **Order** | The order number, or **Draft** if it hasn't been assigned a number yet |
| **Date** | The order date |
| **Status** | The order's current stage (for example, draft, confirmed) |
| **Total** | The order total |
| **Reorder** | Loads that order's items back into your cart |

**To reorder**, click **Reorder** on any past order. Its items load into your cart and you're taken to the **Orders** tab with the message "Items loaded into your cart. Prices will be confirmed at current rates when you submit." Adjust quantities as needed and submit as a fresh order.

> Reorder shows each item's **previous** price as a starting point, but the **current** price always applies when you submit — so a reordered item may cost a little more or less than last time.

---

## 9.7 Your account and invoices

The **Account** tab shows your financial standing with Ring of Fire:

- A large **Open balance** figure at the top (what your company currently owes), with your company name beneath it.
- An **Invoices** table listing each invoice with its **Invoice** number, **Date**, **Due** date, **Status**, **Total**, **Paid**, and **Balance**.

Use the **All statuses** dropdown in the Invoices header to filter to a particular invoice status.

> The Account tab is **view-only**. There is no online payment in the portal today — to pay an invoice, follow your normal arrangement with Ring of Fire. If a balance looks wrong, contact your rep.

### Signing out

Click **Logout** in the top-right at any time. You'll return to the sign-in screen and can sign back in with a fresh email link.

---

## 9.8 For Ring of Fire staff: setting the portal up

The portal is built but **inert until configured**. A buyer can't even sign in until you authorize them, and even then the catalog stays empty until you enter prices. All of the setup happens in the internal Tangerine app, under the **Customers** section, plus a one-time technical configuration.

There are four things to get right:

1. **Sign-in delivery** (one-time, technical) — the sign-in email and the return web address must be configured so the magic link actually sends and lands back on `/b2b`. This is a Supabase Auth configuration task; coordinate with whoever administers the Supabase project. Until it's done, buyers never receive a link.
2. **Authorize each buyer** — add the buyer in **B2B Buyers** (see [§9.9](#99-authorizing-buyers-b2b-buyers)).
3. **Enter wholesale prices** — add prices in **B2B Price List** (see [§9.10](#910-setting-wholesale-prices-b2b-price-list)).
4. **(Optional but recommended) Add product images** — so the catalog cards look like a real storefront (see [§9.11](#911-product-images)).

> A buyer needs **both** an active authorization **and** at least one priced style before the portal is useful to them. A style with no price for that buyer simply won't be orderable (it shows "Call for price" with no Add button).

---

## 9.9 Authorizing buyers (B2B Buyers)

In Tangerine, open **Customers → B2B Buyers** (🛍️). This is the gatekeeper: only emails listed here as **active** can sign in to the portal.

For each buyer, create a row that sets:

| Field | What it does |
|---|---|
| **Customer** | The Ring of Fire customer this buyer belongs to — this is what scopes everything they see |
| **Email** | The exact address the buyer will sign in with |
| **Display name** | The name shown in the portal's top bar |
| **Role** | Buyer, approver, or admin (informational today — ordering is controlled by the next field) |
| **Active** | Switch on to allow sign-in; switch off to revoke access |
| **Can place orders** | On = can submit orders; off = browse/build only (Submit order is disabled for them) |

The first time a buyer signs in with their email, the portal automatically links their sign-in identity to this row and records the sign-in time — those two fields are read-only here; you don't fill them in.

> **To switch a buyer off**, set their row to inactive. The next time they try to sign in (or their session checks in) they'll be signed out and shown the "Not authorized" message. Buyers cannot self-register — every buyer must be added here first.

---

## 9.10 Setting wholesale prices (B2B Price List)

In Tangerine, open **Customers → B2B Price List** (🏷️). Each row sets a price for a **style**, and you choose how broadly it applies:

| Price type | Applies to | When to use |
|---|---|---|
| **Customer-specific** | One named customer's buyers | A negotiated price for one account |
| **Tier** | All customers on a pricing tier | A standard price for a group of customers |
| **Default** | Everyone with no more specific price | A catch-all base price |

For each row you set the **price**, **currency**, an optional **minimum quantity**, and optional **effective-from / effective-to** dates so a price can start or expire on a schedule.

How a buyer's price gets chosen, per style, **most specific wins**:

1. A **customer-specific** price for their account, if one exists; otherwise
2. A **tier** price matching their customer's tier; otherwise
3. The **default** price.

Only active rows within their effective date range count. If two equally-specific prices exist, the **lower** one wins. A style with no applicable price at all shows the buyer **Call for price** and can't be ordered.

> This price list is the **interim** pricing source. There are no volume/quantity breaks, promotions, or contract pricing in it yet — every price a buyer should see has to exist as a row here. Adding a price for a style is what makes it orderable in the portal.

---

## 9.11 Product images

Catalog cards show a product image when one is available; otherwise they show a neat placeholder with the first few characters of the style code, so the grid still looks uniform. Images come from the style's primary product image in the system (uploaded, or pulled from a connected Shopify store). Adding images is optional — the portal works without them — but it makes the storefront far more presentable. Until images are added, expect placeholder tiles.

---

## 9.12 How buyers are kept separate (and safe)

A few things are worth knowing as the operator:

- **Each buyer is locked to one customer.** Everything a buyer sees — catalog prices, orders, invoices, balance, shipping locations — is scoped on the server to the single customer on their **B2B Buyers** row. The buyer's browser never tells the server which customer they are or what a price should be; the server decides both. This means a buyer can never see another customer's pricing or orders.
- **Sessions are isolated.** A buyer's portal sign-in is completely separate from staff sign-ins and the vendor portal — all three can be open in different browser tabs without interfering.
- **Submitted prices are always re-checked.** When a buyer submits (or reorders), Ring of Fire's server re-calculates the price from the current **B2B Price List**, ignoring whatever price the buyer's screen showed. A buyer can't manipulate a price by editing their cart.

---

## 9.13 What's not in the portal yet

- **No online payment.** The Account tab shows balance and invoices but has no pay-online / card-capture step.
- **No multi-step approvals.** Roles (buyer/approver/admin) are recorded but there's no in-portal approval chain — the only ordering gate is the **Can place orders** switch.
- **No self-registration.** Staff must authorize every buyer in **B2B Buyers**.
- **Pricing is the simple price list only.** No quantity breaks, promotions, or contract pricing yet — see [§9.10](#910-setting-wholesale-prices-b2b-price-list).

---

## 9.14 Quick troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Buyer never gets the sign-in email | Sign-in email delivery / return address not configured | Complete the one-time Supabase Auth setup ([§9.8](#98-for-ring-of-fire-staff-setting-the-portal-up) step 1) |
| Buyer signs in but sees "Not authorized" | No active **B2B Buyers** row for that email | Add or re-activate the buyer in **B2B Buyers** |
| Catalog is empty / everything says "Call for price" | No applicable prices in **B2B Price List** | Add customer/tier/default prices for the styles |
| "Portal unavailable" on the sign-in screen | Portal not configured at all | Coordinate with whoever administers the system |
| Buyer can browse but **Submit order** is greyed out | **Can place orders** is off for that buyer | Turn it on in **B2B Buyers** (or have an authorized colleague submit) |
| Catalog shows placeholder tiles, no photos | No product images set for those styles | Add primary product images ([§9.11](#911-product-images)) |
