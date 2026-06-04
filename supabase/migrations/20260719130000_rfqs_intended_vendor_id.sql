-- RFQ "send gate": record the destined vendor on the RFQ at generation time,
-- but DON'T create the rfq_invitations row (which is what makes the RFQ visible
-- to the vendor) until an internal user explicitly clicks "Send to Vendor".
--
-- Before this, generating RFQs from a costing project immediately inserted an
-- rfq_invitations row, so the draft RFQ appeared in the vendor portal before
-- anyone sent it. Now generate stamps intended_vendor_id and stays a private
-- draft; api/internal/rfqs/:id/publish creates the invitation on first send.

ALTER TABLE rfqs
  ADD COLUMN IF NOT EXISTS intended_vendor_id uuid REFERENCES vendors(id);

CREATE INDEX IF NOT EXISTS idx_rfqs_intended_vendor_id ON rfqs(intended_vendor_id);

COMMENT ON COLUMN rfqs.intended_vendor_id IS
  'Costing-generated RFQs: the vendor this RFQ is destined for, stamped at generation. The rfq_invitations row that exposes the RFQ to the vendor portal is only created on Send to Vendor (publish), so generate stays a private draft.';
