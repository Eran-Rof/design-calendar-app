-- Carrier Master: shipping carrier reference data.
CREATE TABLE IF NOT EXISTS carrier_master (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL DEFAULT rof_entity_id(),
  code text NOT NULL,
  name text NOT NULL,
  carrier_type text NOT NULL DEFAULT 'parcel',
  tracking_url_template text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT carrier_master_entity_code_unique UNIQUE (entity_id, code)
);
CREATE INDEX IF NOT EXISTS carrier_master_entity_id_idx ON carrier_master(entity_id);

-- Pre-populate with common carriers for the ROF entity.
-- Uses rof_entity_id() so it lands on the correct entity automatically.
INSERT INTO carrier_master (entity_id, code, name, carrier_type, tracking_url_template, sort_order)
SELECT
  rof_entity_id(), code, name, carrier_type, tracking_url, sort_order
FROM (VALUES
  ('UPS',     'UPS',                         'parcel',  'https://www.ups.com/track?tracknum={tracking}',                         10),
  ('USPS',    'United States Postal Service','parcel',  'https://tools.usps.com/go/TrackConfirmAction?tLabels={tracking}',       20),
  ('FEDEX',   'FedEx',                       'parcel',  'https://www.fedex.com/apps/fedextrack/?tracknumbers={tracking}',        30),
  ('DHL',     'DHL Express',                 'parcel',  'https://www.dhl.com/en/express/tracking.html?AWB={tracking}',           40),
  ('ONTRAC',  'OnTrac',                      'parcel',  'https://www.ontrac.com/trackingdetail.asp?tracking={tracking}',         50),
  ('LSO',     'LSO (Lone Star Overnight)',   'parcel',  'https://www.lso.com/tracking/{tracking}',                              60),
  ('SPEEDEE', 'Spee-Dee Delivery',           'parcel',  NULL,                                                                    70),
  ('AMAZON',  'Amazon Logistics',            'parcel',  NULL,                                                                    80),
  ('ABF',     'ABF Freight (ArcBest)',       'ltl',     NULL,                                                                    90),
  ('XPO',     'XPO Logistics',              'ltl',     NULL,                                                                   100),
  ('ESTES',   'Estes Express Lines',         'ltl',     NULL,                                                                   110),
  ('ODFL',    'Old Dominion Freight Line',   'ltl',     NULL,                                                                   120),
  ('RLCARR',  'R+L Carriers',               'ltl',     NULL,                                                                   130),
  ('MAERSK',  'Maersk Line',                'ocean',   NULL,                                                                   140),
  ('EVERGRN', 'Evergreen Marine',            'ocean',   NULL,                                                                   150),
  ('COSCO',   'COSCO Shipping',              'ocean',   NULL,                                                                   160)
) AS t(code, name, carrier_type, tracking_url, sort_order)
ON CONFLICT (entity_id, code) DO NOTHING;
