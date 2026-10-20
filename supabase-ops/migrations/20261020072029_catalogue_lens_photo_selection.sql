create or replace function ee_lens.catalogue_receive(p_draft_id uuid, p_revision bigint, p_lens_id bigint, p_data jsonb, p_photos jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare link ee_lens.catalogue_links; pid bigint; matches bigint[]; photo jsonb; cover_id bigint; photo_id bigint; n integer:=0; identity_key text;
begin
  if p_revision<1 or length(trim(coalesce(p_data->>'name','')))=0 or length(trim(coalesce(p_data->>'brand','')))=0
     or jsonb_array_length(p_photos)<1 or jsonb_array_length(p_photos)>20 then
    raise exception 'Review the product and its photos before saving to EE Lens.';
  end if;
  identity_key:=lower(trim(p_data->>'brand')||'|'||trim(coalesce(nullif(p_data->>'model',''),p_data->>'name'))||'|'||trim(coalesce(p_data->>'colour',''))||'|'||regexp_replace(coalesce(p_data->>'size',''),'\s','','g'));
  perform pg_advisory_xact_lock(hashtextextended(p_draft_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended(identity_key,1));
  select * into link from ee_lens.catalogue_links where draft_id=p_draft_id for update;
  if found then
    if link.revision>p_revision then raise exception 'A newer version is already saved in EE Lens.'; end if;
    if not exists(select 1 from ee_lens.products where id=link.product_id and deleted_at is null) then
      raise exception 'This product was removed from EE Lens. Review it before publishing.';
    end if;
    if link.revision=p_revision then return jsonb_build_object('lensId',link.product_id,'revision',link.revision); end if;
    pid:=link.product_id;
  elsif p_lens_id is not null then
    select id into pid from ee_lens.products where id=p_lens_id and deleted_at is null for update;
    if pid is null then raise exception 'The linked EE Lens product is missing.'; end if;
  else
    select array_agg(id) into matches from ee_lens.products
    where deleted_at is null and lower(trim(brand))=lower(trim(p_data->>'brand'))
      and lower(trim(coalesce(nullif(model,''),name)))=lower(trim(coalesce(nullif(p_data->>'model',''),p_data->>'name')))
      and lower(trim(coalesce(colour,'')))=lower(trim(coalesce(p_data->>'colour','')))
      and lower(regexp_replace(coalesce(size,''),'\s','','g'))=lower(regexp_replace(coalesce(p_data->>'size',''),'\s','','g'));
    if cardinality(matches)>1 then raise exception 'Several EE Lens products match. Check the model, colour and size.'; end if;
    pid:=matches[1];
  end if;
  if pid is not null and exists(select 1 from ee_lens.catalogue_links where product_id=pid and draft_id<>p_draft_id) then
    raise exception 'This EE Lens product is already linked to another website draft.';
  end if;
  if pid is null then
    insert into ee_lens.products(client_id,brand,name,model,category,colour,size,price,description,specs)
    values(p_draft_id,p_data->>'brand',p_data->>'name',p_data->>'model',p_data->>'category',p_data->>'colour',p_data->>'size',nullif(p_data->>'price','')::numeric,p_data->>'description',coalesce(p_data->'specs','{}')) returning id into pid;
  else
    update ee_lens.products set brand=p_data->>'brand',name=p_data->>'name',model=p_data->>'model',category=p_data->>'category',colour=p_data->>'colour',size=p_data->>'size',price=nullif(p_data->>'price','')::numeric,description=p_data->>'description',specs=coalesce(p_data->'specs','{}'),updated_at=now() where id=pid;
  end if;
  -- Preserve photos added separately in Lens; this draft owns only its own paths.
  for photo in select value from jsonb_array_elements(p_photos) loop
    insert into ee_lens.product_photos(client_id,product_id,role,storage_path,sort_order,checksum)
    values((photo->>'client_id')::uuid,pid,'catalogue',photo->>'storage_path',n,photo->>'checksum')
    on conflict(client_id) do update set sort_order=excluded.sort_order
    returning id into photo_id;
    if n=0 then cover_id:=photo_id; end if;
    n:=n+1;
  end loop;
  update ee_lens.products set cover_photo_id=cover_id,updated_at=now() where id=pid;
  -- Remove deselected photos previously copied by this draft. Storage files remain recoverable.
  delete from ee_lens.product_photos pp
  where pp.product_id=pid and pp.role='catalogue'
    and pp.storage_path like p_draft_id::text||'/%'
    and not exists(select 1 from jsonb_array_elements(p_photos) chosen where chosen->>'storage_path'=pp.storage_path);
  insert into ee_lens.catalogue_links(draft_id,product_id,revision) values(p_draft_id,pid,p_revision)
  on conflict(draft_id) do update set revision=excluded.revision,synced_at=now();
  return jsonb_build_object('lensId',pid,'revision',p_revision);
end $$;

