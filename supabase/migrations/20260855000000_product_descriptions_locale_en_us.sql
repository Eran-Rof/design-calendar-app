-- Align Shopify-synced product descriptions to the locale the PIM Description
-- tab reads ("en-US"). The earlier bulk sync wrote them under "en", so the tab
-- showed empty even though the rows existed. Flip "en" -> "en-US" wherever the
-- style does not already have an "en-US" row (idempotent; no-op on a fresh DB
-- where the table is empty).
update product_descriptions pd
   set locale = 'en-US'
 where pd.locale = 'en'
   and not exists (
     select 1 from product_descriptions p2
      where p2.style_id = pd.style_id
        and p2.locale = 'en-US'
   );
