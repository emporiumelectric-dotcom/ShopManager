-- Only the server-side receiver can remove deselected catalogue photo records.
grant delete on ee_lens.product_photos to service_role;
