# 23. Searchable Dropdowns (T9 cross-cutter)

> **T9 status (2026-05-28):** component + sweep shipped. PRs #458 (component) + #459 (Tangerine panel sweep, 25 swaps across 11 panels).

T9 replaces native `<select>` dropdowns with a typeable `<SearchableSelect>` on every panel where the option list is long, comes from a DB table that grows, or has a code + name pattern. Operator workflow: type a few characters to filter, ↑/↓ to highlight, Enter to commit.

---

## What changed

Before T9: customer pickers, vendor pickers, GL account pickers, sales rep filters, period pickers all rendered as native `<select>` with scroll-and-find. With 100+ customers / vendors / accounts, that's friction every time.

After T9: same panels render a typeable input that filters in real time. Click to open, type to filter, ↑/↓ to navigate, Enter to commit, Esc to close.

---

## Which dropdowns got the component

Per arch §2 selection rule — apply when ANY of:
- Option list comes from a DB table that grows (`customers`, `vendors`, `employees`, `gl_accounts`, `style_master`, `sales_reps`, `gl_periods`, `fabric_codes`, `payment_terms`, `bank_accounts`, `entities`, `product_categories`, `customer_users`).
- Option list exceeds 10 entries today.
- Option label combines code + name (e.g. `1100 - Cash`).

**Skipped** (short closed enums — search would be cargo-culted UX): `status`, `severity`, `priority`, `payment_method`, `feed_source`, `direction`, `basis`, `kind`, `account_type`, `normal_balance`.

---

## Behaviors worth knowing

- **Keyboard:** ↑/↓ scrolls highlight; Enter commits the highlighted option; Esc closes without commit + reverts to previously-selected display; Tab closes + moves focus to the next form field.
- **Click-outside** closes the panel.
- **First open with no prior value:** initial highlight is index 0, so the first ↓ moves you to index 1. (Tell me if you'd rather it not pre-highlight; one-line flip.)
- **Selected option** has a subtle background tint inside the panel so it's visible even when highlight is elsewhere.
- **Group headers** (e.g. "Assets / Liabilities / Equity / Revenue / Expense" on the GL account picker) pin to top of the scrolled panel — sticky positioning.
- **200-item cap:** when filtered results exceed 200 visible items, the panel shows the first 200 with a "showing 200 of N — refine your search" footer.
- **`searchHaystack` override:** the picker can include UUIDs / aliases in the search but not the display label. Useful when you want to paste a customer UUID and have it match.

---

## A11y

ARIA combobox pattern: `role=combobox` on the wrapper, `role=listbox` on the panel, `role=option` on each item, `aria-activedescendant` tracks the highlight, `aria-expanded` toggles on open/close. Screen-reader-tested against jsdom's combobox semantics.

---

## Forward rule

Per the new memory rule `feedback_searchable_select_on_long_dropdowns.md`:

> Every new Tangerine panel that adds a dropdown sourced from a DB-backed (growing) list, or with > 10 options, or with a code + name label pattern, MUST use `<SearchableSelect>` from `src/tanda/components/SearchableSelect.tsx`. Short closed enums stay as native `<select>`.

Goes in the same PR as the new panel, not a follow-up. Same enforcement pattern as the universal `<ExportButton>` rule (T3).

---

## Drop-in API

```tsx
import SearchableSelect from "./components/SearchableSelect";
import type { SearchableSelectOption } from "./components/SearchableSelect";

const options: SearchableSelectOption[] = customers.map((c) => ({
  value: c.id,
  label: `${c.code} — ${c.name}`,
  searchHaystack: `${c.code} ${c.name} ${c.id}`,   // optional; defaults to label
}));

<SearchableSelect
  value={selectedCustomerId}
  onChange={setSelectedCustomerId}
  options={options}
  placeholder="Pick a customer…"
/>
```

Same shape as a controlled native `<select>` — `value` + `onChange` + option list. Drop-in compatible.

---

## Date range presets

Wherever you set a **from / to date range** to filter — a report, a list, a dashboard, the Inventory Snapshot header and its Sold / Purchased drill popups, commission payouts, AR/AP invoices and payments, GL detail, trial balance, and so on — a **Presets** dropdown sits to the left of the two date inputs. Pick a quick range and the From / To dates fill in for you:

- **MTD** (month-to-date), **YTD** (year-to-date)
- **Last 30 / 60 / 90 days**
- **This / Last month**, **This / Last quarter**, **This / Last year**
- **This year → last month**
- **Custom…** to type the dates yourself

Every preset is **relative to today** — it recomputes each time you use it (never a frozen date range), so "Last 30 days" always means the 30 days ending today.

**Manage and add your own presets** from **Master Data → Date Presets**. The built-in presets above are pre-loaded there as editable rows, so you can relabel, reorder, or hide any of them, and add new ones (e.g. "Last 14 days"). Anything you change there appears automatically in **every** date-range Presets dropdown across all the apps — no per-screen setup. See [Master Data → Date Presets Master](02-master-data.md#-date-presets-master).

> The Presets dropdown only appears on date-**range** filters (a from *and* a to). Single-date entry fields — order / ship / due / effective dates, an "as of" aging date — are not ranges, so they don't carry presets.

---

## Code map

- Component: `src/tanda/components/SearchableSelect.tsx`
- Tests: `src/tanda/components/__tests__/SearchableSelect.test.tsx` (29 cases)
- Arch doc: `docs/tangerine/T9-searchable-dropdowns-architecture.md`
- T9 PRs: #458 (component) + #459 (Tangerine sweep, 25 swaps across 11 panels)
