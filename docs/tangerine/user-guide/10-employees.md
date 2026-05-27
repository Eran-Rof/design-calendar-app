# Employees (M30 — HR / Employee Master)

**Shipped in P2 Chunks 7 + 8** (2026-05-27).

The minimum HR identity layer the rest of the ERP needs: one record per human (employee, contractor, future hire). Drives display-name resolution everywhere an audit trail points at a user.

## Where it lives

`/tangerine` top nav → **👥 Employees**.

## What it's for

- Resolve `created_by_user_id` UUIDs to **real names** via `v_audit_user_resolved`
- Hold per-person identity (name, title, department, manager chain, hire/termination dates)
- Bind to an `auth.users` account **optionally** — contractors and future hires can exist before they have a login

## Out of scope (stretch-post-launch)

- Payroll
- Time tracking
- Benefits

If those land later they extend `employees` rather than replace it.

## CRUD details

| Action | Behavior |
|---|---|
| **Add** | code + email unique per entity. Hire/termination dates optional. auth_user_id optional. |
| **Edit** | All fields editable EXCEPT `code` and `entity_id` (locked). Set `auth_user_id` later when a login is provisioned. |
| **Deactivate** | Soft-delete only (`is_active=false`). We never hard-delete because the audit trail and manager-chain self-FK still reference rows. |
| **Manager chain** | Dropdown of other active employees; ON DELETE SET NULL. |

## v_audit_user_resolved view

```sql
SELECT u.id AS user_id, u.email, e.display_name, e.code, e.title, e.entity_id
  FROM auth.users u
  LEFT JOIN employees e ON e.auth_user_id = u.id;
```

Use it everywhere you have a `created_by_user_id` (or any `auth.users.id`) and want to render a person's name. Returns `display_name = NULL` for auth accounts with no matching employee record — fall back to email in that case.

## Seed

The schema migration inserts one placeholder row for the ROF entity:

```
code=EB001, first_name=Eran, last_name=Bitton, title=CEO, department=Executive, is_active=true
```

If an `auth.users` row matches `eran@ringoffireclothing.com`, the seed sets `auth_user_id` to that uuid. Otherwise `auth_user_id` stays NULL — set it manually via the edit modal once the login is in place.

## Related architecture

- [`../P2-cross-cutters-architecture.md` §7](../P2-cross-cutters-architecture.md) — full M30 spec
