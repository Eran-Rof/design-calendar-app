# Email draft — Chart of Accounts request

Forward this to the accountant. Replace `[name]` and any company-specific bracketed placeholders.

---

**Subject:** Chart of Accounts for new in-house ERP — need your canonical list

Hi [name],

We're building an in-house ERP to replace Xoro over the next 24-30 months. The first step is standing up the General Ledger, and for that I need the canonical Chart of Accounts you'd like us to use going forward.

Specifically, can you send back a list with these columns for every account:

| Column | What it is | Example |
|---|---|---|
| **Account number** | Whatever numbering scheme you prefer (4-digit, 5-digit, ranges like 1000–1999 = assets) | `1100` |
| **Account name** | The display name | `Accounts Receivable — Wholesale` |
| **Type** | One of: asset, liability, equity, revenue, expense, contra_asset, contra_revenue | `asset` |
| **Subtype** | Optional finer category | `current_asset`, `ar` |
| **Parent account number** | If it rolls up to another account, give the parent's number. Leave blank for top-level. | `1000` |
| **Postable?** | yes/no. "no" means it's a roll-up parent only — no journal entries land directly. | yes |
| **Control account?** | yes only for AR, AP, and Inventory accounts that get fed exclusively by sub-ledger postings | yes |

Two things that matter for how we'll use this:

1. **Dual basis (accrual + cash).** Every journal entry in the new system produces *both* an accrual and a cash twin, joined together. The COA itself stays the same in both books — no separate "cash" accounts needed. If you have a preference on how revenue/expense recognition timing should differ between the two books for AP/AR specifically, let me know.

2. **5-year backfill.** We're loading 5 closed fiscal years of AR history. The COA you send needs to cover every account that was active during those years (even if some are now inactive — mark `status=inactive` rather than omitting). If an account name changed during that window, give us both the old and current names with a note on when it changed.

If easier, you can just export the current Xoro COA as a CSV and annotate it with the columns above. We can clean up from there.

Format: CSV, Excel, or a doc — any is fine.

Timing: this gates a couple of weeks of build work, so the sooner the better. Even a partial list (just the top 30 accounts in active use) unblocks most of what we need now, and you can fill in the rest after.

Thanks,
Eran
