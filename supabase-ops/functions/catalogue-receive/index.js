import { createClient } from 'npm:@supabase/supabase-js@2.112.2';

// Cross-project requests keep the operations gateway JWT check and additionally
// verify the website owner's session. The browser never gets a service key.
const SITE='https://dnmzzckeuctnkqbphwdg.supabase.co';
const OWNER='21e0db6b-373f-4793-93ac-b82ba79e569d';
const site=createClient(SITE,'sb_publishable_TkuJuy1AF1wixYRIPCh2WA_U8A-Pxn3',{auth:{persistSession:false}});
const admin=createClient(Deno.env.get('SUPABASE_URL'),Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false}});
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function json(body,status=200){return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});}
function checked(result){if(result.error)throw Error(result.error.message);return result.data;}
async function sha(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');}
function imageUrl(raw,draftId){
  const u=new URL(raw);
  const published=u.pathname.startsWith('/storage/v1/object/public/product-photos/')&&!u.search;
  const privateDraft=uuid.test(draftId||'')&&new RegExp('^/storage/v1/object/sign/catalogue-drafts/'+draftId+'/[a-f0-9]{64}\\.jpg$').test(u.pathname)&&u.searchParams.has('token')&&[...u.searchParams.keys()].every(k=>k==='token');
  if(u.origin!==SITE||(!published&&!privateDraft)||u.hash||u.username||u.password)throw Error('Only saved catalogue photos can be sent to EE Lens.');return u;
}
async function handle(req){
  if(req.method!=='POST')return json({error:'Method not allowed'},405);
  try{
    const token=req.headers.get('x-website-token');if(!token)return json({error:'Website owner sign-in required'},401);
    const {data,error}=await site.auth.getUser(token);
    if(error||!data.user)return json({error:'Your website session expired. Sign in again.'},401);
    if(data.user.id!==OWNER)return json({error:'Website owner access required'},403);
    const raw=await req.text();if(raw.length>150000)return json({error:'Product data is too large'},413);
    const b=JSON.parse(raw);
    if(b.action==='check')return json({ready:true});
    if(!uuid.test(b.id)||!Number.isSafeInteger(b.revision)||b.revision<1||!Array.isArray(b.images)||!b.images.length||b.images.length>20)throw Error('Invalid product snapshot.');
    if(b.lensId&&!/^\d+$/.test(String(b.lensId)))throw Error('Invalid EE Lens product.');
    const p=b.data;if(!p?.name?.trim()||!p.brand?.trim()||!p.category?.trim()||!p.priceReviewed||(p.choices?.length&&!p.variantReviewed))throw Error('Review this product before publishing.');
    if(p.price&&!/^\d+(\.\d{1,2})?$/.test(p.price))throw Error('Invalid selling price.');
    // Idempotency is also enforced transactionally in the receiving RPC.
    const photos=[];
    for(const rawUrl of b.images){
      const response=await fetch(imageUrl(rawUrl,b.id),{redirect:'error',signal:AbortSignal.timeout(25000)});
      if(!response.ok)throw Error('A catalogue photo could not be copied to EE Lens. Retry this row.');
      const reader=response.body.getReader(),parts=[];let size=0;
      while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>5*1024*1024){await reader.cancel();throw Error('A catalogue photo is too large.');}parts.push(value);}
      const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
      if(bytes[0]!==255||bytes[1]!==216||bytes[2]!==255)throw Error('A catalogue photo must be a JPEG.');
      const hash=await sha(bytes),identity=await sha(new TextEncoder().encode(b.id+hash));
      const clientId=[identity.slice(0,8),identity.slice(8,12),identity.slice(12,16),identity.slice(16,20),identity.slice(20,32)].join('-');
      const path=`${b.id}/${hash}.jpg`;
      checked(await admin.storage.from('ee-lens-photos').upload(path,bytes,{contentType:'image/jpeg',upsert:true}));
      photos.push({client_id:clientId,storage_path:path,checksum:hash});
    }
    const lensData={...p,description:[p.description,(p.features||[]).length?'Features\n'+p.features.map(f=>'• '+f.title+(f.text?' — '+f.text:'')).join('\n'):''].filter(Boolean).join('\n\n')};
    return json(checked(await admin.schema('ee_lens').rpc('catalogue_receive',{p_draft_id:b.id,p_revision:b.revision,p_lens_id:b.lensId||null,p_data:lensData,p_photos:photos})));
  }catch(e){return json({error:e.message||'EE Lens could not save this product.'},400);}
}
Deno.serve(handle);
