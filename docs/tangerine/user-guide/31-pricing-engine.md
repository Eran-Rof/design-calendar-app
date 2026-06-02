# 31. Pricing Engine — Price Lists & Promotions (M43)

> **M43 status (2026-06-02):** engine + B2B unify shipped #792; admin UI (this chapter) shipped #793. Internal Sales-Order / AR price **auto-fill** lands in a follow-up (Chunk C). The engine replaces the interim B2B price list — staff pricing and the B2B portal now resolve through **one** engine.

The Pricing Engine answers a single question everywhere a price is needed: **"what does this customer pay for this style, at this quantity, on this date?"** You manage it from two panels under the new **💲 Pricing** nav group.

## 31.1 How a price is resolved

For a `(customer, style, quantity, date)` the engine walks price lists **most-specific first** and uses the **first list that prices the style**:

1. **The customer's own list** — a price list whose scope is that specific customer.
2. **The customer's assigned list** — the shared list set on the customer (e.g. "Distributor"), via Customer Master → Reps & Defaults → **Price list**.
3. **The tier list** — a list whose scope is the customer's `customer_tier`.
4. **The Default list** — the global fallback (`Default Wholesale`, seeded).

Within the chosen list, if the style has **quantity breaks** (multiple prices at different minimum quantities), the engine takes the price for the **highest minimum quantity that the order quantity meets**. Finally, the best (largest-discount) matching **promotion** in effect that day is applied on top. Prices always resolve at the **style** level (every size of a style shares the price).

## 31.2 Price Lists panel (`💲 Pricing → Price Lists`)

The list shows every price list with its **scope** (Default / Tier / Customer), currency, and item count. Click a row to open it.

**Creating a list** — give it a `Code`, `Name`, currency, and pick a **Scope**:
- **Default (fallback)** — the catch-all. Keep exactly one active default.
- **Customer tier** — type the tier string (must match `customers.customer_tier`).
- **Specific customer** — pick the customer; this becomes that customer's own list.

**Adding prices & quantity breaks** — inside a saved list, **+ Add price** opens the price editor: pick the **Style**, enter the **Price**, and a **Min qty** (use `0` for the base price; add more rows at `12`, `144`, … for break pricing). Optional **effective from/to** dates gate when the price applies. Each `(style, min-qty)` is unique within a list — editing an existing break re-opens the same editor.

## 31.3 Promotions panel (`💲 Pricing → Promotions`)

A promotion is a time-boxed discount layered on the resolved list price:
- **Type** — Percent (0–100) or Amount ($ off).
- **Code** — optional; leave blank for an automatic promo (no code needed).
- **Applies to** — any combination of Style / Brand / Customer / Customer tier; **leave a field blank to match anything** on that dimension. Plus an optional **Min qty**.
- **Effective from / to**, **Active**.

When several promotions match, the engine applies the **single largest discount** — promotions do **not** stack (v1).

## 31.4 Assigning a customer to a list

Customer Master → edit a customer → **Reps & Defaults** tab → **Price list**. Leaving it `(default / tier)` means the customer falls through to its tier list, then the Default list.

## 31.5 Where it's used today

- **B2B portal** — the catalog and order-create already resolve through this engine (no change for buyers; prices now come from your price lists instead of the old B2B price-list table).
- **Internal Sales Orders / AR** — a follow-up chunk will pre-fill the suggested unit price on each line from this engine (still editable). Until then, the engine powers the B2B portal and the `GET /api/internal/pricing/resolve` check endpoint.

## What's NOT yet usable
- **SO/AR auto-fill** — ships in Chunk C; until then staff still type SO/AR line prices manually.
- **Size-level prices, multi-currency, promotion stacking, cost-plus auto-pricing** — out of scope for v1 (see `../M43-pricing-engine-architecture.md`).
- Setting a customer's price list on the **create** screen isn't persisted yet — create the customer first, then edit to assign the list.
