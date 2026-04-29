export interface NotificationRow {
  id: string;
  event_type: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
  recipient_auth_id: string | null;
  recipient_internal_id: string | null;
  metadata: Record<string, unknown> | null;
}
