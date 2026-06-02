# Screenshots

Capture target list (14 PNGs, ~1920×1080 or 1280×800 for modal views). Drop captures here with the filenames referenced from the markdown files.

| Filename | Where it's referenced | Captures |
|---|---|---|
| `01-tangerine-login.png` | 01-getting-started.md | `/tangerine` when not signed in: orange-T logo card centered on dark gradient background, "Sign in with Microsoft" white button visible |
| `01-tangerine-home.png` | 01-getting-started.md | `/tangerine` landing page (signed in): top nav with 6 module buttons + 🧩 Apps ▾ + signed-in email + Sign out button on the right + module cards grouped Master Data / Accounting + "Other apps in the suite" grid at the bottom |
| `01-tangerine-apps-launcher.png` | 01-getting-started.md | Apps ▾ dropdown open showing the 7 app links (Design Calendar, PO WIP, ATS, Tech Packs, GS1, Planning, Vendor Portal) |
| `02-style-master-list.png` | 02-master-data.md | Style Master list view with search box + show-deleted toggle + several rows |
| `02-style-master-add-modal.png` | 02-master-data.md | Style Master + Add modal with all fields populated |
| `02-vendor-master-list.png` | 02-master-data.md | Vendor Master list with several rows |
| `02-customer-master-list.png` | 02-master-data.md | Customer Master list with the customer-type filter dropdown visible |
| `03-coa-list.png` | 03-accounting.md | COA list with several accounts |
| `03-coa-add-modal.png` | 03-accounting.md | COA + Add modal mid-creation, showing the auto-derived `normal_balance` |
| `03-coa-delete-blocked.png` | 03-accounting.md | The 409 alert: "Account has posted journal entry lines; mark it inactive…" |
| `03-periods-list.png` | 03-accounting.md | Periods list with FY 2026 card expanded (12 monthly rows) + status dropdown open on one row |
| `03-je-list.png` | 03-accounting.md | Journal Entry list with a mix of posted (green) + reversed (red, grayed) rows |
| `03-je-post-modal-balanced.png` | 03-accounting.md | Post Manual JE modal with 2 balanced lines, green "● Balanced" footer |
| `03-je-post-modal-unbalanced.png` | 03-accounting.md | Same modal but in red "● Out of balance by X.XX" state |

## Capture environment

Per the user-guide plan: **operator captures from authenticated production session** (or a vetted preview deploy) at their convenience. Reasons:

- PII concerns — vendor/customer names from production data shouldn't land in a public repo until the operator has confirmed they're OK to show.
- The CEO already has the right login + a populated environment; the developer doesn't.

Until the captures land, the markdown files reference these PNG paths but the images don't exist. Markdown previewers will show broken-image icons — that's expected.

## Filename convention

`<chapter-number>-<short-slug>.png` so the file order matches the doc order when listed alphabetically.

## PII guidance for screenshots

Before committing screenshots, blur or redact:

- Vendor / customer names (use a placeholder name like `Acme Co` or `Test Customer` instead)
- Tax IDs (already excluded from UI but double-check the page)
- Email addresses
- Bank-account fragments
- Any specific dollar amounts that reveal financials

The 6 panels themselves are safe to screenshot — only the *data inside them* needs PII review.
