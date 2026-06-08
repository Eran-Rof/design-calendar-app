-- Allow a vendor (authenticated role) to DELETE their OWN notifications.
--
-- The notifications table already has, for the authenticated role:
--   vendor_own_notifications_select  (recipient_auth_id = auth.uid())
--   vendor_own_notifications_update  (recipient_auth_id = auth.uid())
-- but no DELETE policy, so the vendor portal's new "delete notification"
-- action was blocked by RLS. Internal apps use the anon key and are already
-- covered by the permissive anon_all_notifications (FOR ALL) policy, so this
-- only adds the missing authenticated-vendor DELETE path. Scoped to the
-- caller's own rows — a vendor can never delete another recipient's row.

DROP POLICY IF EXISTS vendor_own_notifications_delete ON public.notifications;

CREATE POLICY vendor_own_notifications_delete
  ON public.notifications
  FOR DELETE
  TO authenticated
  USING (recipient_auth_id = auth.uid());
