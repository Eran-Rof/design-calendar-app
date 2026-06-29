-- Reconcile sales_orders.sale_store (imported from Xoro SaleStoreName) to the
-- canonical Warehouses master names, so the SO Warehouse field + filter can source
-- from the warehouses master (inventory_locations kind='warehouse') instead of the
-- distinct Xoro names. Tangerine has warehouses + brands, no sales stores.
--
-- Mapping (Xoro name -> warehouse master name):
--   ROF Main              -> Main Warehouse
--   ROF - ECOM            -> ROF Ecom
--   Prebook - Psycho Tuna -> Psycho Tuna   (prebook is a timing concept, not a warehouse)
--   Psycho Tuna           -> Psycho Tuna   (already matches the master; no-op)
-- Idempotent: re-running finds nothing once values are canonical.

UPDATE sales_orders SET sale_store = 'Main Warehouse' WHERE sale_store = 'ROF Main';
UPDATE sales_orders SET sale_store = 'ROF Ecom'       WHERE sale_store = 'ROF - ECOM';
UPDATE sales_orders SET sale_store = 'Psycho Tuna'    WHERE sale_store = 'Prebook - Psycho Tuna';
