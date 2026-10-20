-- Run on OPERATIONS. Every test row is rolled back; no catalogue fixtures remain.
begin;
set local role service_role;
do $$
declare d uuid:=gen_random_uuid(); photo_id uuid:=gen_random_uuid(); p jsonb; photos jsonb; first_result jsonb; again jsonb; pid bigint; original_count bigint;
begin
  p:=jsonb_build_object('brand','Catalogue transaction test','name',d::text,'model',d::text,'colour','White','size','1200 mm','category','Fans','price','','specs','{}'::jsonb);
  photos:=jsonb_build_array(jsonb_build_object('client_id',photo_id,'storage_path',d::text||'/test.jpg','checksum','test'));
  select count(*) into original_count from ee_lens.products;
  first_result:=ee_lens.catalogue_receive(d,1,null,p,photos);pid:=(first_result->>'lensId')::bigint;
  again:=ee_lens.catalogue_receive(d,1,null,p,photos);
  if first_result<>again or (select count(*) from ee_lens.products)<>original_count+1 then raise exception 'Replay created a duplicate'; end if;
  if (select price from ee_lens.products where id=pid) is not null then raise exception 'Call-for-price was not preserved'; end if;
  insert into ee_lens.product_photos(product_id,role,storage_path) values(pid,'shop',d::text||'/shop.jpg');
  perform ee_lens.catalogue_receive(d,2,null,p||'{"name":"Updated test name"}'::jsonb,photos);
  if (select count(*) from ee_lens.product_photos where product_id=pid)<>2 then raise exception 'Photo replay or shop photo preservation failed'; end if;
  insert into ee_lens.product_photos(product_id,role,storage_path) values(pid,'catalogue','manual-lens/keep.jpg');
  photos:=jsonb_build_array(jsonb_build_object('client_id',gen_random_uuid(),'storage_path',d::text||'/replacement.jpg','checksum','replacement'));
  perform ee_lens.catalogue_receive(d,3,null,p,photos);
  if exists(select 1 from ee_lens.product_photos where product_id=pid and storage_path=d::text||'/test.jpg') then raise exception 'Deselected managed photo remained'; end if;
  if (select count(*) from ee_lens.product_photos where product_id=pid)<>3 then raise exception 'Shop or manually added Lens photo was lost'; end if;
  if (select cover_photo_id from ee_lens.products where id=pid)<>(select id from ee_lens.product_photos where product_id=pid and storage_path=d::text||'/replacement.jpg') then raise exception 'Cover did not move to selected photo'; end if;
  begin
    perform ee_lens.catalogue_receive(d,1,null,p,photos);
    raise exception 'Expected stale revision rejection';
  exception when raise_exception then
    if sqlerrm='Expected stale revision rejection' then raise; end if;
  end;
  begin
    perform ee_lens.catalogue_receive(gen_random_uuid(),1,pid,p,photos);
    raise exception 'Expected duplicate link rejection';
  exception when raise_exception then
    if sqlerrm='Expected duplicate link rejection' then raise; end if;
  end;
  if has_function_privilege('anon','ee_lens.catalogue_receive(uuid,bigint,bigint,jsonb,jsonb)','EXECUTE') or has_function_privilege('authenticated','ee_lens.catalogue_receive(uuid,bigint,bigint,jsonb,jsonb)','EXECUTE') then raise exception 'Receiver RPC exposed to clients'; end if;
end $$;
select 'Lens create, replay, update, preserved shop photo, stale revision, duplicate link and access checks passed' as verification;
rollback;
