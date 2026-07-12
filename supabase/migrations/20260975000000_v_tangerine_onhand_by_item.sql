-- v_tangerine_onhand_by_item — per-item Tangerine on-hand (Σ live FIFO layers).
--
-- The Tangerine side of the nightly Tangerine ⇄ Xoro-REST on-hand tie-out
-- (rof_xoro_project/scripts/verify_tangerine_onhand.py). Exposed as an
-- anon-readable view so the reconciliation reads it the same way
-- verify_ats_totals.py reads canonical tables (paginated PostgREST, anon key)
-- — no service-role key in the nightly. The Xoro side of the tie-out is the
-- raw REST inventory CSV (the unprocessed Xoro API on-hand), NOT
-- tangerine_size_onhand, so the check is independent of the ingest that
-- produces both inventory_layers and that snapshot.
create or replace view v_tangerine_onhand_by_item as
select item_id,
       sum(remaining_qty)::numeric as onhand_qty
from inventory_layers
where remaining_qty > 0
group by item_id;

grant select on v_tangerine_onhand_by_item to anon, authenticated;
