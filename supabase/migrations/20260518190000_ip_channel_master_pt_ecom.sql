-- Add PT ECOM channel to ip_channel_master.
--
-- ROF / ROF ECOM / PT were seeded in 20260518030000. PT ECOM is the
-- new one: Shopify orders under Sale Store "Psycho Tuna" with Customer
-- = "Shopify psychotuna". sync-invoices.js routes those rows here;
-- everything else under "Psycho Tuna" stays in PT (wholesale).
--
-- Idempotent: ON CONFLICT keeps any pre-existing PT ECOM row untouched.

INSERT INTO ip_channel_master (channel_code, name, channel_type, active)
VALUES
  ('PT ECOM', 'Psycho Tuna — Ecom', 'ecom', true)
ON CONFLICT (channel_code) DO NOTHING;
