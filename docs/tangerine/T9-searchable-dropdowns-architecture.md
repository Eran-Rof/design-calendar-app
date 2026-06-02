# Cross-cutter T9 — Searchable dropdowns

Status: **PLAN ONLY** (2026-05-28). Operator ask: "wherever there is a drop down menu add search bar on any string". Plan-only PR first; implementation sweep as a follow-up.

This is a small UI cross-cutter — a drop-in `<SearchableSelect>` component that replaces native `<select>` elements with a typeable filter on top. Operator volume of customers / vendors / accounts / employees / styles is past the point where scroll-and-find works.

---

## 0. Scope

**In scope (v1):**
- One component: `src/tanda/components/SearchableSelect.tsx` (Tangerine-first; reusable across apps).
- Drop-in API mirrors native `<select>` so the sweep is mechanical:
  ```tsx
  <SearchableSelect
    value={accountId}
    onChange={setAccountId}
    options={accounts.map(a => ({ value: a.id, label: `${a.code} — ${a.name}` }))}
    placeholder="Pick an account…"
  />
  ```
- Type-ahead filter on the label string (case-insensitive `.includes()`); no fuzzy matching in v1.
- Keyboard navigation: ↑/↓ to highlight, Enter to select, Esc to close.
- Sweep every panel where the dropdown has > 10 options. Short enum dropdowns (status / severity / payment_method) stay as native `<select>` — search would be cargo-culted UX there.
- Memory rule: every new panel that adds a dropdown with > 10 options ships `<SearchableSelect>`.

**Out of scope (v2 if asked):**
- Multi-select with chips.
- Async / server-side search (component is client-side only against the in-memory options).
- Custom render per option (icons / two-line / etc.).
- Dropdown virtualization for > 1000 options.
- Touch / mobile-optimized variant.

---

## 1. Component API (locked decision)

```tsx
export type SearchableSelectOption = {
  value: string;
  label: string;
  searchHaystack?: string;   // optional override; defaults to label
  disabled?: boolean;
  group?: string;            // optional section header for grouped options
};

export type SearchableSelectProps = {
  value: string | null;
  onChange: (value: string) => void;
  options: SearchableSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  emptyText?: string;        // shown when no options match the filter
  inputStyle?: React.CSSProperties;
  panelMaxHeight?: number;   // default 280px
  autoFocus?: boolean;
};
```

Visual treatment matches the dark Tangerine palette and reuses the existing `inputStyle` patterns used by every Internal*.tsx panel.

---

## 2. Selection rule — which dropdowns get the component

Apply when **any** of these is true:

- The option list comes from a DB table that can grow (customers, vendors, employees, gl_accounts, styles, sales_reps, periods, fabric_codes, payment_terms, customer_users, entities).
- The option list exceeds 10 entries today, even if from an enum (rare in our codebase).
- The option label includes a code + name pattern (e.g. `1100 - Cash`) — search by either side is helpful.

Do **not** apply when:

- The options are a short closed enum (`status`, `severity`, `priority`, `account_kind`, `payment_method`, `feed_source`, `direction`, `basis`, `kind`).
- The control is a tab strip / segment-control disguised as a select (Bank Recon Accounts vs Transactions tabs, etc).

A judgment call exists for a handful of mid-sized lists (account_subtype with ~12 values; locale with whatever future list). Default: keep native unless the operator complains.

---

## 3. Implementation strategy

Pure custom (no new dep). `react-select` and friends would solve this fully but add ~50KB and don't match the dark theme out of the box. ~150 lines of TSX for the v1 contract is cheaper than dependency churn.

Internals:
- Single input field that toggles a panel `<ul>` below on focus.
- Filter via `useMemo(() => options.filter(o => haystack(o).toLowerCase().includes(q.toLowerCase())), [options, q])`.
- Click-outside via `useRef + useEffect` listening on `mousedown` (same pattern as the existing T3 `<ExportButton>` dropdown — well-tested).
- Keyboard: track `highlightIdx` in component state; `↑/↓` scrolls, `Enter` calls `onChange(filtered[highlightIdx].value)` + closes, `Esc` closes without commit, `Tab` moves focus + closes.
- Selected option's label is shown in the input when the panel is closed; cleared input as you type.

---

## 4. Chunk split (when implementation kicks off)

| Chunk | Title | Scope | Depends on |
|---|---|---|---|
| **T9-1** | Component + unit tests | `SearchableSelect.tsx` + 20-30 unit tests covering filter behavior, keyboard nav, group headers, disabled options, click-outside, empty-state. | — |
| **T9-2** | Sweep — Tangerine panels | Replace `<select>` with `<SearchableSelect>` in every Tangerine panel matching §2 selection rule. ~30-40 dropdowns across ~20 panels. Pattern is mechanical (same as T3 export sweep). | T9-1 |
| **T9-3** | Sweep — ATS / PO WIP / Tech Packs / GS1 / Planning / Vendor portal | Same component in non-Tangerine apps. Lower-priority but operator volume here is higher (vendor pickers in ATS, customer pickers in PO WIP, style pickers in Tech Packs). | T9-1 |
| **T9-4** | Memory rule + per-chunk update | Extend `feedback_memorize_each_chunk.md` so every new panel with a >10-option dropdown ships `<SearchableSelect>`. User guide chapter add. | T9-3 |

Estimated **~1 day** end-to-end. T9-2 and T9-3 are parallel-safe after T9-1. The sweep is mechanical — same template as T3's universal-export sweep that finished in a few hours with 4 parallel agents.

---

## 5. Risks

- **Form library coupling.** Some panels use react-hook-form / formik wrappers around their `<select>`. The component must work with both controlled (`value` + `onChange`) and form-lib-controlled patterns. Solution: keep the API pure controlled (value + onChange); form libs adapt easily.
- **Accessibility regression.** Native `<select>` has built-in a11y; a custom popover loses keyboard-trap-safety + screen-reader semantics. Solution: ARIA combobox pattern (role=combobox + role=listbox + aria-activedescendant). Tested with VoiceOver / NVDA spot-checks during T9-1.
- **Long initial render.** Some pickers load ~5000 styles. Filter runs every keystroke; with 5000 rows that's ~1ms — fine. But initial render of 5000 `<li>` elements is ~50ms. v1 caps the rendered list at 200 items (top-N after sort) and surfaces a "showing 200 of 5000 — refine your search" footer. v2 = virtualization.
- **Match against IDs.** Operator sometimes pastes a UUID into a customer search. Allow `searchHaystack` to include `value` so UUID typing works. Default haystack = label-only.

---

## 6. Pairs with

- [[feedback-universal-table-export]] — same drop-in-everywhere sweep pattern.
- [[project-t6-global-search-plan]] — overlaps on "type-to-find" but different scope: T6 is cross-entity content search; T9 is in-context picker filtering.
- [[feedback-memorize-each-chunk]] — per-chunk memorization extension covers T9.

---

## 7. When to implement

After P8 Wave B (CRM + PIM handlers) lands. PIM in particular adds at least 3 long pickers (category tree, attribute definition, style — both of which need search). Best to ship the component while a real consumer is in flight.
