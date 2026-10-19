begin;
do $test$
declare draft uuid:=gen_random_uuid(); payload jsonb; result jsonb; pid bigint; bad boolean:=false;
begin
payload:=jsonb_build_object('name','__catalogue_transaction_test__','brand','Test','category','Fans','price','100','priceReviewed',true,'inStock',true,'photos',jsonb_build_array(jsonb_build_object('url','https://example.com/test.jpg')),'specs','{}'::jsonb,'variants',jsonb_build_array(jsonb_build_object('variant_type','colour','variant_value','White','in_stock',true)));
perform public.catalogue_save(draft,0,payload,'__test__'||draft::text);
result:=public.catalogue_publish(draft,1,'["https://example.com/test.jpg"]'::jsonb); pid:=(result->>'website_id')::bigint;
if (select count(*) from public.product_images where product_id=pid)<>1 then raise exception 'image insert failed'; end if;
if (select count(*) from public.product_variants where product_id=pid)<>1 then raise exception 'variant insert failed'; end if;
result:=public.catalogue_publish(draft,1,'["https://example.com/test.jpg"]'::jsonb);
if (result->>'website_id')::bigint<>pid then raise exception 'retry created a new product'; end if;
payload:=jsonb_set(payload,'{name}','"__changed_draft_only__"'::jsonb);
perform public.catalogue_save(draft,1,payload,'__test__'||draft::text);
if (select "Name" from public.products where id=pid)<>'__catalogue_transaction_test__' then raise exception 'draft leaked to website'; end if;
begin perform public.catalogue_publish(draft,1,'["https://example.com/test.jpg"]'::jsonb); exception when serialization_failure then bad:=true; end;
if not bad then raise exception 'stale revision accepted'; end if;
perform public.catalogue_publish(draft,2,'["https://example.com/test.jpg"]'::jsonb);
if (select "Name" from public.products where id=pid)<>'__changed_draft_only__' then raise exception 'publish failed'; end if;
perform public.catalogue_unpublish(draft,2);
perform set_config('catalogue.test_id',pid::text,true);
if has_table_privilege('anon','public.catalogue_drafts','SELECT') or has_table_privilege('authenticated','public.catalogue_drafts','SELECT') then raise exception 'draft read grant leaked'; end if;
if has_function_privilege('anon','public.catalogue_publish(uuid,bigint,jsonb)','EXECUTE') or has_function_privilege('authenticated','public.catalogue_publish(uuid,bigint,jsonb)','EXECUTE') then raise exception 'publish privilege leaked'; end if;
end $test$;
set local role anon;
do $test$ begin
if exists(select 1 from public.products where id=current_setting('catalogue.test_id')::bigint) then raise exception 'unpublished product exposed'; end if;
if exists(select 1 from public.product_images where product_id=current_setting('catalogue.test_id')::bigint) then raise exception 'unpublished images exposed'; end if;
if exists(select 1 from public.product_variants where product_id=current_setting('catalogue.test_id')::bigint) then raise exception 'unpublished variants exposed'; end if;
end $test$;
reset role;
rollback;
select 'publish/update/idempotency/conflict/unpublish/RLS checks passed; test data rolled back' as result;
