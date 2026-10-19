-- Target: dnmzzckeuctnkqbphwdg (website), NOT the operations database.
-- Additive publication boundary; all existing products keep their IDs and visibility.
begin;
alter table public.products add column is_published boolean not null default true;
alter policy "public read products" on public.products using (is_published);
alter policy "public read images" on public.product_images using (
  exists (select 1 from public.products p where p.id = product_id and p.is_published)
);
alter policy "public read variants" on public.product_variants using (
  exists (select 1 from public.products p where p.id = product_id and p.is_published)
);

create table public.catalogue_drafts (
  id uuid primary key default gen_random_uuid(),
  website_id bigint unique references public.products(id) on delete set null,
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  dedupe_key text,
  revision bigint not null default 1,
  published_revision bigint,
  publication text not null default 'draft' check (publication in ('draft','published','unpublished')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz
);
create unique index catalogue_drafts_dedupe on public.catalogue_drafts(dedupe_key) where dedupe_key is not null;
alter table public.catalogue_drafts enable row level security;
revoke all on public.catalogue_drafts from public, anon, authenticated;
grant all on public.catalogue_drafts to service_role;

create table public.catalogue_imports (
  id uuid primary key,
  url text not null,
  state text not null default 'pending' check (state in ('pending','failed','complete')),
  error text,
  draft_id uuid references public.catalogue_drafts(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index catalogue_imports_draft_id_idx on public.catalogue_imports(draft_id);
alter table public.catalogue_imports enable row level security;
revoke all on public.catalogue_imports from public, anon, authenticated;
grant all on public.catalogue_imports to service_role;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('catalogue-drafts','catalogue-drafts',false,5242880,array['image/jpeg','image/png','image/webp']);

-- Import the existing catalogue as published snapshots, including its variant links.
insert into public.catalogue_drafts(website_id,data,publication,published_revision,published_at)
select p.id,jsonb_build_object(
  'name',coalesce(p."Name",''),'brand',coalesce(p."Brand",''),
  'category',coalesce(p."Category",''),'description',coalesce(p."Spec",''),
  'price',coalesce(p."Price",''),'priceReviewed',true,'inStock',coalesce(p.in_stock,false),
  'photos',coalesce((select jsonb_agg(jsonb_build_object('url',i.image_url) order by i.sort_order,i.id)
                    from public.product_images i where i.product_id=p.id and i.image_url is not null),
                   case when coalesce(p."Photo_url",'')<>'' then jsonb_build_array(jsonb_build_object('url',p."Photo_url")) else '[]'::jsonb end),
  'specs','{}'::jsonb,
  'variants',coalesce((select jsonb_agg(to_jsonb(v)-'id'-'product_id') from public.product_variants v where v.product_id=p.id),'[]'::jsonb)
),'published',1,now() from public.products p;

-- Service-only, invoker functions: the Edge Function verifies the named owner first.
create function public.catalogue_save(p_id uuid,p_revision bigint,p_data jsonb,p_key text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare d public.catalogue_drafts;
begin
  select * into d from public.catalogue_drafts where id=p_id for update;
  if found then
    if d.data=p_data then return jsonb_build_object('draft',to_jsonb(d)); end if;
    if d.revision<>p_revision then raise exception 'This product changed in another tab. Reload it before saving.' using errcode='40001'; end if;
    update public.catalogue_drafts set data=p_data,dedupe_key=p_key,revision=revision+1,updated_at=now() where id=p_id returning * into d;
  else
    if p_revision<>0 then raise exception 'Product not found'; end if;
    if p_key is not null then
      select * into d from public.catalogue_drafts where dedupe_key=p_key;
      if found then return jsonb_build_object('draft',to_jsonb(d),'duplicate',true); end if;
    end if;
    insert into public.catalogue_drafts(id,data,dedupe_key) values(p_id,p_data,p_key) returning * into d;
  end if;
  return jsonb_build_object('draft',to_jsonb(d));
exception when unique_violation then
  raise exception 'This model already exists. Open the existing product instead.' using errcode='23505';
end $$;

create function public.catalogue_publish(p_id uuid,p_revision bigint,p_images jsonb)
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
  spec:=concat_ws(E'\n\n',nullif(d.data->>'description',''),
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

create function public.catalogue_unpublish(p_id uuid,p_revision bigint)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare d public.catalogue_drafts;
begin
  select * into d from public.catalogue_drafts where id=p_id for update;
  if not found then raise exception 'Product not found'; end if;
  if d.revision<>p_revision then raise exception 'This product changed. Reload it before unpublishing.' using errcode='40001'; end if;
  update public.products set is_published=false where id=d.website_id;
  update public.catalogue_drafts set publication='unpublished',updated_at=now() where id=p_id returning * into d;
  return to_jsonb(d);
end $$;
revoke all on function public.catalogue_save(uuid,bigint,jsonb,text),public.catalogue_publish(uuid,bigint,jsonb),public.catalogue_unpublish(uuid,bigint) from public,anon,authenticated;
grant execute on function public.catalogue_save(uuid,bigint,jsonb,text),public.catalogue_publish(uuid,bigint,jsonb),public.catalogue_unpublish(uuid,bigint) to service_role;
commit;
