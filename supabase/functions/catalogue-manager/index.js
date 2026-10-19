import { createClient } from 'npm:@supabase/supabase-js@2.112.2';

const OWNER = '21e0db6b-373f-4793-93ac-b82ba79e569d';
const URL_BASE = Deno.env.get('SUPABASE_URL');
const admin = createClient(URL_BASE, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), {auth:{persistSession:false}});
const cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS'};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const norm = v => String(v||'').trim().toLowerCase().replace(/\s+/g,' ');
function fail(message,status=400){const e=new Error(message);e.status=status;throw e;}
function check(result){if(result.error)fail(result.error.message,/(changed|exists)/i.test(result.error.message)?409:400);return result.data;}
function id(v){if(!uuid.test(v||''))fail('Invalid product ID.');return v;}
function json(value,status=200){return new Response(JSON.stringify(value),{status,headers:{...cors,'Content-Type':'application/json','Cache-Control':'no-store'}});}

// Only public HTTP(S) hosts. Validate DNS and every redirect before requesting a body.
function publicAddress(address){
  const a=address.toLowerCase().replace(/^\[|\]$/g,'');
  if(a.includes(':'))return /^(2|3)[0-9a-f]{0,3}:/.test(a)&&!a.startsWith('2001:db8:')&&!a.startsWith('2002:')&&!a.startsWith('2001:0:');
  if(!/^\d+\.\d+\.\d+\.\d+$/.test(a))return false;
  const n=a.split('.').map(Number);return n.every(x=>x>=0&&x<=255)&&n[0]!==0&&n[0]!==10&&n[0]!==127&&n[0]<224&&!(n[0]===169&&n[1]===254)&&!(n[0]===172&&n[1]>=16&&n[1]<=31)&&!(n[0]===192&&(n[1]===168||n[1]===0))&&!(n[0]===100&&n[1]>=64&&n[1]<=127)&&!(n[0]===198&&(n[1]===18||n[1]===19));
}
async function publicUrl(raw){
  let u;try{u=new URL(raw);}catch{fail('Enter a valid product or image URL.');}
  if(!['https:','http:'].includes(u.protocol)||u.username||u.password||(u.port&&!['80','443'].includes(u.port)))fail('Only public website URLs are supported.');
  const h=u.hostname.replace(/^\[|\]$/g,'');
  if(h.includes(':')||/^\d+(\.\d+){3}$/.test(h)){if(!publicAddress(h))fail('Private network URLs are not allowed.');}
  else{
    if(!h.includes('.')||/\.(local|internal|localhost|test|invalid)$/i.test(h))fail('Private network URLs are not allowed.');
    const resolved=await Promise.allSettled([Deno.resolveDns(h,'A'),Deno.resolveDns(h,'AAAA')]);
    const addresses=resolved.flatMap(r=>r.status==='fulfilled'?r.value:[]);
    if(!addresses.length||addresses.some(a=>!publicAddress(a)))fail('This host could not be verified as a public website.');
  }
  return u;
}
async function download(raw,image=false){
  let u=await publicUrl(raw);
  const limit=image?8*1024*1024:4*1024*1024;
  for(let redirect=0;redirect<5;redirect++){
    const response=await fetch(u,{redirect:'manual',signal:AbortSignal.timeout(25000),headers:{'User-Agent':'ElectricEmporium-Catalogue/1.0','Accept':image?'image/*':'text/html,application/xhtml+xml','Accept-Language':'en-IN,en;q=0.9'}});
    if([301,302,303,307,308].includes(response.status)){const location=response.headers.get('location');await response.body?.cancel();if(!location)fail('The source returned an invalid redirect.');u=await publicUrl(new URL(location,u).href);continue;}
    if(!response.ok){await response.body?.cancel();fail(`The source website returned ${response.status}. You can enter the product manually.`,422);}
    const type=(response.headers.get('content-type')||'').split(';')[0];
    if(image?!['image/jpeg','image/png','image/webp','image/avif','image/gif'].includes(type):!['text/html','application/xhtml+xml'].includes(type)){await response.body?.cancel();fail(image?'This URL is not a supported image.':'This URL is not a product webpage.');}
    const reader=response.body.getReader();const parts=[];let size=0;
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();fail('The source file is too large.');}parts.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
    if(image)return {bytes,type};
    const html=new TextDecoder().decode(bytes);
    if(/<title[^>]*>\s*(just a moment|access denied|robot check|are you human)/i.test(html)||html.includes('/cdn-cgi/challenge-platform/'))fail('This website blocked automatic importing. Add the details and photos manually, or use a supplier spreadsheet.',422);
    return {html,finalUrl:u.href};
  }
  fail('The website redirected too many times.');
}
function cleanData(value,draftId,previous){
  if(!value||typeof value!=='object'||Array.isArray(value))fail('Product details are required.');
  const p={};for(const field of ['name','brand','category','model','colour','size','description','price','mrp','sourceUrl','lensId'])p[field]=String(value[field]??'').trim().slice(0,field==='description'?12000:2000);
  for(const field of ['price','mrp']){p[field]=p[field].replace(/^(₹|Rs\.?|INR)\s*/i,'').replace(/,/g,'');if(p[field]&&!/^\d+(\.\d{1,2})?$/.test(p[field]))fail('Prices must be positive numbers or blank.');if(p[field]&&Number(p[field])<=0)fail('Prices must be positive numbers or blank.');}
  p.priceReviewed=value.priceReviewed===true;p.variantReviewed=value.variantReviewed===true;p.inStock=value.inStock===true;
  p.specs={};for(const [k,v] of Object.entries(value.specs||{}).slice(0,80))if(k.trim())p.specs[k.slice(0,100)]=String(v).slice(0,2000);
  p.photos=(value.photos||[]).slice(0,20).map(photo=>{
    if(photo.path&&new RegExp('^'+draftId+'/[a-f0-9]{64}\\.jpg$').test(photo.path))return {path:photo.path};
    if(photo.url&&(previous?.photos||[]).some(x=>x.url===photo.url))return {url:photo.url};
    fail('An image must be uploaded before saving this product.');
  });
  p.candidates=(value.candidates||[]).filter(x=>typeof x==='string'&&/^https?:\/\//i.test(x)).slice(0,20);
  p.choices=(value.choices||[]).slice(0,60);
  p.stockIds=(value.stockIds||[]).filter(x=>uuid.test(x)).slice(0,30);
  p.variants=(value.variants||[]).slice(0,60).map(v=>({variant_type:String(v.variant_type||'').slice(0,80),variant_value:String(v.variant_value||'').slice(0,120),price:String(v.price||'').slice(0,30),in_stock:v.in_stock!==false,linked_product_id:/^\d+$/.test(String(v.linked_product_id||''))?String(v.linked_product_id):null})).filter(v=>v.variant_type&&v.variant_value);
  return p;
}
async function getDraft(value){const d=check(await admin.from('catalogue_drafts').select('*').eq('id',id(value)).maybeSingle());if(!d)fail('Product not found.',404);return d;}
async function allRows(table,query=q=>q){let rows=[];for(let from=0;from<20000;from+=500){const page=check(await query(admin.from(table).select('*')).range(from,from+499));rows.push(...page);if(page.length<500)return rows;}fail('The catalogue is too large to load in one request.');}
let opsConfig;
async function opsAuth(){
  if(!opsConfig){const r=await fetch('https://manager.electricemporium.in/config.json',{signal:AbortSignal.timeout(15000)});if(!r.ok)fail('Stock connection is unavailable.',502);opsConfig=await r.json();}
  const base=opsConfig.supabaseUrl||opsConfig.SUPABASE_URL||opsConfig.url;
  const key=opsConfig.supabaseAnonKey||opsConfig.SUPABASE_ANON_KEY||opsConfig.anonKey;
  if(base!=='https://buzidwccluskdkccidev.supabase.co'||!key)fail('Stock connection configuration is unavailable.',502);
  return {base,key};
}
async function opsPhoto(path){
  if(!/^[a-z0-9_-]+\/[a-z0-9_-]+\.jpg$/i.test(path))fail('Invalid EE Lens photo path.');
  const {base,key}=await opsAuth();
  const r=await fetch(`${base}/storage/v1/object/ee-lens-photos/${path}`,{signal:AbortSignal.timeout(30000),headers:{apikey:key,Authorization:`Bearer ${key}`}});
  if(!r.ok)fail('An EE Lens catalogue photo could not be read. Retry this product.',502);
  const bytes=new Uint8Array(await r.arrayBuffer());if(bytes.length>5*1024*1024||bytes[0]!==255||bytes[1]!==216)fail('An EE Lens photo is not a supported JPEG.');return bytes;
}
async function ops(table,query,schema='public'){
  const {base,key}=await opsAuth();
  const r=await fetch(`${base}/rest/v1/${table}?${query}`,{signal:AbortSignal.timeout(20000),headers:{apikey:key,Authorization:`Bearer ${key}`,'Accept-Profile':schema}});
  if(!r.ok)fail('Could not read the shop catalogue.',502);return r.json();
}
async function handle(req){
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
  if(req.method!=='POST')return json({error:'Method not allowed'},405);
  try{
    const token=(req.headers.get('authorization')||'').replace(/^Bearer\s+/i,'');
    if(!token)fail('Sign in to manage the catalogue.',401);
    const {data,error}=await admin.auth.getUser(token);if(error||!data.user)fail('Your session expired. Sign in again.',401);
    if(data.user.id!==OWNER)fail('Only the website owner can manage the catalogue.',403);
    if(Number(req.headers.get('content-length')||0)>8000000)fail('This upload is too large.',413);
    const raw=await req.text();if(raw.length>8000000)fail('This upload is too large.',413);const b=JSON.parse(raw);
    if(b.action==='list'){
      const drafts=await allRows('catalogue_drafts',q=>q.order('updated_at',{ascending:false}));
      const paths=drafts.map(d=>d.data.photos?.[0]?.path).filter(Boolean),covers=[];
      for(let i=0;i<paths.length;i+=100)covers.push(...check(await admin.storage.from('catalogue-drafts').createSignedUrls(paths.slice(i,i+100),3600)));
      return json({drafts,covers,jobs:check(await admin.from('catalogue_imports').select('*').neq('state','complete').order('created_at').limit(1000))});
    }
    if(b.action==='save'){
      id(b.id);const old=check(await admin.from('catalogue_drafts').select('data').eq('id',b.id).maybeSingle());
      const p=cleanData(b.data,b.id,old?.data);const key=p.brand&&(p.model||p.name)?[p.brand,p.model||p.name,p.colour,p.size].map(norm).join('|'):null;
      if(!old&&p.sourceUrl){
        const matches=check(await admin.from('catalogue_drafts').select('*').eq('data->>sourceUrl',p.sourceUrl).limit(100));
        const match=matches.find(d=>norm(d.data.model)===norm(p.model)&&norm(d.data.colour)===norm(p.colour)&&norm(d.data.size)===norm(p.size));
        if(match)return json({draft:match,duplicate:true});
      }
      return json(check(await admin.rpc('catalogue_save',{p_id:b.id,p_revision:b.revision,p_data:p,p_key:key})));
    }
    if(b.action==='upload'){
      id(b.id);if(!/^[a-f0-9]{64}$/.test(b.hash||''))fail('Invalid image checksum.');
      const binary=atob(b.base64||'');if(binary.length>5*1024*1024||binary.length<4)fail('Image must be under 5 MB.');
      const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));if(bytes[0]!==255||bytes[1]!==216||bytes[2]!==255)fail('Please upload a JPEG image.');
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');if(hash!==b.hash)fail('The image checksum does not match.');
      const path=`${b.id}/${hash}.jpg`;check(await admin.storage.from('catalogue-drafts').upload(path,bytes,{contentType:'image/jpeg',upsert:true}));
      return json({path});
    }
    if(b.action==='sign'){
      const d=await getDraft(b.id);const paths=d.data.photos.filter(p=>p.path).map(p=>p.path);
      const signed=paths.length?check(await admin.storage.from('catalogue-drafts').createSignedUrls(paths,3600)):[];
      return json({photos:d.data.photos.map(p=>({...p,preview:p.url||signed.find(s=>s.path===p.path)?.signedUrl}))});
    }
    if(b.action==='publish'){
      const d=await getDraft(b.id);if(d.revision!==b.revision)fail('This product changed. Reload before publishing.',409);
      if(!d.data.name?.trim()||!d.data.brand?.trim()||!d.data.category?.trim()||!d.data.priceReviewed||!d.data.photos?.length||(d.data.choices?.length&&!d.data.variantReviewed))fail('Review the product details, price, variant and photos before publishing.');
      const images=[];for(const p of d.data.photos){
        if(p.url){images.push(p.url);continue;}
        const file=check(await admin.storage.from('catalogue-drafts').download(p.path));
        const target=`catalogue/${p.path}`;check(await admin.storage.from('product-photos').upload(target,file,{contentType:'image/jpeg',upsert:true}));
        images.push(admin.storage.from('product-photos').getPublicUrl(target).data.publicUrl);
      }
      return json({draft:check(await admin.rpc('catalogue_publish',{p_id:d.id,p_revision:b.revision,p_images:images}))});
    }
    if(b.action==='unpublish')return json({draft:check(await admin.rpc('catalogue_unpublish',{p_id:id(b.id),p_revision:b.revision}))});
    if(b.action==='fetchPage')return json(await download(b.url));
    if(b.action==='fetchImage'){const {bytes,type}=await download(b.url,true);return new Response(bytes,{headers:{...cors,'Content-Type':type,'Cache-Control':'no-store'}});}
    if(b.action==='queue'){
      if(!Array.isArray(b.jobs)||b.jobs.length>200)fail('Import up to 200 links at a time.');
      const jobs=b.jobs.map(j=>({id:id(j.id),url:String(j.url).slice(0,2500),state:'pending'}));
      if(jobs.some(j=>!/^https?:\/\//i.test(j.url)))fail('Product links must start with https://.');
      return json({jobs:check(await admin.from('catalogue_imports').upsert(jobs,{onConflict:'id',ignoreDuplicates:true}).select())});
    }
    if(b.action==='job')return json({job:check(await admin.from('catalogue_imports').update({state:['pending','failed','complete'].includes(b.state)?b.state:'pending',error:String(b.error||'').slice(0,1000),draft_id:b.draftId?id(b.draftId):null,updated_at:new Date().toISOString()}).eq('id',id(b.id)).select().single())});
    if(b.action==='lens')return json({products:await ops('products','select=*&deleted_at=is.null&order=id','ee_lens'),photos:await ops('product_photos','select=*&role=eq.catalogue&order=sort_order','ee_lens')});
    if(b.action==='lensImport'){
      if(!/^\d+$/.test(String(b.lensId)))fail('Invalid EE Lens product.');
      const existing=check(await admin.from('catalogue_drafts').select('*').eq('data->>lensId',String(b.lensId)).limit(1));if(existing.length)return json({draft:existing[0],duplicate:true});
      const [p]=await ops('products',`select=*&deleted_at=is.null&id=eq.${b.lensId}`,'ee_lens');if(!p)fail('EE Lens product not found.',404);
      const same=(await allRows('catalogue_drafts')).find(d=>norm(d.data.brand)===norm(p.brand)&&norm(d.data.name)===norm(p.name));if(same)return json({draft:same,duplicate:true});
      const images=await ops('product_photos',`select=storage_path&product_id=eq.${b.lensId}&role=eq.catalogue&order=sort_order`,'ee_lens');
      const draftId=id(b.id),photos=[];
      for(const image of images.slice(0,20)){
        const bytes=await opsPhoto(image.storage_path);
        const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
        const path=`${draftId}/${hash}.jpg`;check(await admin.storage.from('catalogue-drafts').upload(path,bytes,{contentType:'image/jpeg',upsert:true}));photos.push({path});
      }
      const data={name:p.name||'',brand:p.brand||'',model:p.model||'',category:String(b.category||''),colour:p.colour||'',size:p.size||'',description:p.description||'',price:p.price?String(p.price):'',mrp:'',priceReviewed:false,inStock:false,specs:p.specs||{},photos,variants:[],lensId:String(p.id)};
      const key=[data.brand,data.model||data.name,data.colour,data.size].map(norm).join('|');
      return json(check(await admin.rpc('catalogue_save',{p_id:id(b.id),p_revision:0,p_data:data,p_key:key})));
    }
    if(b.action==='stock'){
      const q=String(b.query||'').replace(/[^\p{L}\p{N}\s.-]/gu,'').trim().slice(0,80);
      const query=b.ids?.length?`id=in.(${b.ids.map(id).join(',')})`:`name=ilike.${encodeURIComponent('*'+q+'*')}`;
      return json({items:await ops('items',`select=id,name,qty,store_id&${query}&order=name&limit=100`)});
    }
    fail('Unknown catalogue action.');
  }catch(e){return json({error:e.message||'The request failed. Please try again.'},e.status||400);}
}
Deno.serve(handle);
