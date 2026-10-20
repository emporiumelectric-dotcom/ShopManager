-- OPERATIONS only. The invoker RPC needs explicit server-role access to the
-- existing Lens schema. Browser roles and their policies are unchanged.
grant usage on schema ee_lens to service_role;
grant select, insert, update on ee_lens.products, ee_lens.product_photos to service_role;
grant usage, select on sequence ee_lens.products_id_seq, ee_lens.product_photos_id_seq to service_role;
