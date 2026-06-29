-- 20260808000000_rfq_messages.sql
--
-- RFQ-linked messaging. Lets a vendor message Ring of Fire about an RFQ
-- BEFORE any PO exists (mirrors po_messages, keyed to rfqs instead of
-- tanda_pos). All access flows through the service-role API handlers
-- (api/_handlers/vendor/rfqs/[id]/messages + internal/rfqs/[id]/messages);
-- RLS is enabled with NO policies so the table is service-role-only, the
-- same lockdown pattern used by vendor_invite_tokens.

CREATE TABLE IF NOT EXISTS rfq_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id              uuid NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,

  sender_type         text NOT NULL CHECK (sender_type IN ('vendor', 'internal')),
  sender_auth_id      uuid,                -- vendor_users.auth_id (when sender_type='vendor')
  sender_internal_id  text,                -- internal sender id (when sender_type='internal')
  sender_name         text NOT NULL,       -- denormalised for display

  body                text NOT NULL,

  read_by_vendor      boolean NOT NULL DEFAULT false,
  read_by_internal    boolean NOT NULL DEFAULT false,

  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_rfq_messages_sender CHECK (
    (sender_type = 'vendor'   AND sender_auth_id     IS NOT NULL AND sender_internal_id IS NULL)
 OR (sender_type = 'internal' AND sender_internal_id IS NOT NULL AND sender_auth_id     IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_rfq_messages_rfq_id           ON rfq_messages (rfq_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rfq_messages_sender_auth_id   ON rfq_messages (sender_auth_id) WHERE sender_auth_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rfq_messages_unread_vendor    ON rfq_messages (rfq_id) WHERE read_by_vendor = false;
CREATE INDEX IF NOT EXISTS idx_rfq_messages_unread_internal  ON rfq_messages (rfq_id) WHERE read_by_internal = false;

-- Service-role only: RLS on, zero policies. Every read/write goes through the
-- API handlers which authenticate the vendor (and verify an rfq_invitations
-- row) or gate the internal caller. Mirrors the vendor_invite_tokens lockdown.
ALTER TABLE rfq_messages ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE rfq_messages IS 'RFQ-scoped vendor/internal message thread. Service-role only via API handlers; no RLS policies by design.';
