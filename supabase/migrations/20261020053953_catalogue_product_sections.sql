-- Preserve product details as readable sections in the existing Spec column.
create or replace function public.catalogue_publish(p_id uuid,p_revision bigint,p_images jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare d public.catalogue_drafts; pid bigint; spec text; img jsonb; v jsonb; n integer:=0;
begin
  select * into d from public.catalogue_drafts where id=p_id for update;
  if not found then raise exception 'Product not found'; end if;
  if d.revision<>p_revision then raise exception 'This product changed. Reload it before publishing.' using errcode='40001'; end if;
  if length(trim(coalesce(d.data->>'name','')))=0 or length(trim(coalesce(d.data->>'brand','')))=0
     or length(trim(coalesce(d.data->>'category','')))=0 or coalesce((d.data->>'priceReviewed')::boolean,false)=false
     or jsonb_array_length(p_images)=0
     or (jsonb_array_length(coalesce(d.data->'choices','[]'::jsonb))>0 and coalesce((d.data->>'variantReviewed')::boolean,false)=false)
     then raise exception 'Review the name, brand, category, price, variant and at least one catalogue photo before publishing.'; end if;
  if d.publication='published' and d.published_revision=d.revision then return to_jsonb(d); end if;
  spec:=concat_ws(E'\n\n',case when coalesce(d.data->>'description','')<>'' then 'Description'||E'\n'||(d.data->>'description') end,
    (select 'Features'||E'\n'||string_agg('• '||(f->>'title')||case when coalesce(f->>'text','')<>'' then ' — '||(f->>'text') else '' end,E'\n') from jsonb_array_elements(coalesce(d.data->'features','[]'::jsonb)) f),
    'Technical specifications',
    (select string_agg(key||': '||value,E'\n') from jsonb_each_text(coalesce(d.data->'specs','{}'::jsonb))),
    case when coalesce(d.data->>'model','')<>'' then 'Model: '||(d.data->>'model') end,
    case when coalesce(d.data->>'colour','')<>'' then 'Colour: '||(d.data->>'colour') end,
    case when coalesce(d.data->>'size','')<>'' then 'Size: '||(d.data->>'size') end);
  pid:=d.website_id;
  if pid is null then
    insert into public.products("Name","Brand","Category","Spec","Price","Photo_url",in_stock,is_published)
    values(d.data->>'name',d.data->>'brand',d.data->>'category',spec,d.data->>'price',p_images->>0,
           coalesce((d.data->>'inStock')::boolean,false),true) returning id into pid;
  else
    update public.products set "Name"=d.data->>'name',"Brand"=d.data->>'brand',"Category"=d.data->>'category',
      "Spec"=spec,"Price"=d.data->>'price',"Photo_url"=p_images->>0,in_stock=coalesce((d.data->>'inStock')::boolean,false),is_published=true where id=pid;
  end if;
  delete from public.product_images where product_id=pid;
  for img in select value from jsonb_array_elements(p_images) loop
    insert into public.product_images(product_id,image_url,sort_order) values(pid,img#>>'{}',n); n:=n+1;
  end loop;
  delete from public.product_variants where product_id=pid;
  for v in select value from jsonb_array_elements(coalesce(d.data->'variants','[]'::jsonb)) loop
    insert into public.product_variants(product_id,variant_type,variant_value,price,in_stock,linked_product_id)
    values(pid,v->>'variant_type',v->>'variant_value',v->>'price',coalesce((v->>'in_stock')::boolean,true),nullif(v->>'linked_product_id',''));
  end loop;
  update public.catalogue_drafts set website_id=pid,publication='published',published_revision=revision,published_at=now() where id=p_id returning * into d;
  return to_jsonb(d);
end $$;
