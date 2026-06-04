-- Per-employee in-app notification app routing.
--
-- An employee can select which internal apps they receive in-app
-- notifications in. NULL = all apps (back-compat default — an employee
-- who has never picked apps behaves exactly as before).
--
-- The array holds internal app keys (the AppKey values used by
-- src/components/notifications/notificationApps.ts):
--   tanda, design, ats, techpack, gs1, planning, rof.
-- The external vendor / b2b portals are intentionally NOT selectable.
--
-- Notification rows carry the recipient employee's apps as
-- metadata.target_apps; NotificationsShell + useAppUnreadCount show a row
-- in app X only when (event-type matches X) AND (target_apps is absent OR
-- includes X). A NULL apps array writes no target_apps, preserving the
-- show-everywhere behavior.

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS apps text[];

COMMENT ON COLUMN employees.apps IS
  'Internal app keys where this employee receives in-app notifications (AppKey values: tanda, design, ats, techpack, gs1, planning, rof). NULL = all apps. Mirrored onto notification rows as metadata.target_apps for client-side filtering.';
