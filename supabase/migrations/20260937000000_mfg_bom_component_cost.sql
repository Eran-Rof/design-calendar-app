-- Per-component unit-cost override on mfg_bom_components.
--
-- The BOM editor shows a unit cost + extended cost per component and a BOM
-- total. Unit cost is normally derived (part -> part_master.default_unit_cost_cents,
-- finished_style -> ip_item_avg_cost by sku, service -> service_item_master
-- .default_charge_cents). Services, however, are frequently negotiated per BOM,
-- so the editor lets the operator OVERRIDE the service charge inline. This column
-- persists that override (nullable; NULL = fall back to the master default).

alter table mfg_bom_components
  add column if not exists unit_cost_cents integer;

comment on column mfg_bom_components.unit_cost_cents is
  'Optional per-component unit-cost override (cents). Currently used for service components whose charge is negotiated per BOM; NULL falls back to the master default cost.';
