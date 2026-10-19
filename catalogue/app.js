'use strict';
const SITE_DB='https://dnmzzckeuctnkqbphwdg.supabase.co';
const SITE_KEY='sb_publishable_TkuJuy1AF1wixYRIPCh2WA_U8A-Pxn3';
const OWNER_ID='21e0db6b-373f-4793-93ac-b82ba79e569d';
const client=supabase.createClient(SITE_DB,SITE_KEY,{auth:{storageKey:'ee-catalogue-owner',persistSession:true,autoRefreshToken:true}});
const $=id=>document.getElementById(id);
const form=$('product-form');
let drafts=[],jobs=[],filter='all',selected=new Set(),current=null,dirty=false,queueRunning=false,pauseQueue=false;
const previews=new Map();let working=0,noticeTimer;
const clone=x=>JSON.parse(JSON.stringify(x));
function el(tag,text,cls){const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;}
function notice(message,error=false){$('notice').textContent=message;$('notice').classList.toggle('error',error);$('notice').hidden=false;if($('editor').open)$('editor-note').textContent=message;if($('importer').open)$('import-progress').textContent=message;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('notice').hidden=true,error?15000:6500);}
async function api(action,data={},binary=false){
  const {data:{session},error}=await client.auth.getSession();if(error||!session)throw Error('Sign in to manage your catalogue.');
  const response=await fetch(`${SITE_DB}/functions/v1/catalogue-manager`,{method:'POST',signal:AbortSignal.timeout(90000),headers:{apikey:SITE_KEY,Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({action,...data})});
  if(!response.ok){const body=await response.json().catch(()=>({}));throw Error(body.error||body.message||`Request failed (${response.status}).`);}
  return binary?response.blob():response.json();
}
async function perform(fn,label='Saving…'){
  if(working)return;
  working++;form.inert=!!current;$('working').textContent=label;$('working').hidden=false;if($('editor').open)$('editor-note').textContent=label;
  const buttons=[...document.querySelectorAll('button')].filter(b=>!b.disabled&&!['queue-pause','import-close'].includes(b.id));buttons.forEach(b=>b.disabled=true);
  try{return await fn();}catch(e){notice(e.message||'Something went wrong. Please try again.',true);}finally{working--;form.inert=false;$('working').hidden=true;buttons.forEach(b=>b.disabled=false);updateEditorButtons();}
}
function replaceDraft(d){const i=drafts.findIndex(x=>x.id===d.id);if(i<0)drafts.unshift(d);else drafts[i]=d;render();}
async function load(){const data=await api('list');drafts=data.drafts;jobs=data.jobs;(data.covers||[]).forEach(p=>{if(p.signedUrl)previews.set(p.path,p.signedUrl);});selected=new Set([...selected].filter(id=>drafts.some(d=>d.id===id)));render();renderQueue();}
function fits(d,f){const state=Catalogue.status(d);return f==='all'||f==='draft'&&d.publication==='draft'||f==='attention'&&Catalogue.issues(d.data).length>0||f==='changes'&&state==='Changes to publish'||f==='published'&&d.publication==='published'||f==='unpublished'&&d.publication==='unpublished';}
function visible(){const query=Catalogue.normalize($('search').value),cat=$('category-filter').value;return drafts.filter(d=>fits(d,filter)&&(!cat||d.data.category===cat)&&(!query||Catalogue.normalize([d.data.name,d.data.brand,d.data.model,d.data.colour].join(' ')).includes(query)));}
function formatMoney(value){if(!value)return 'Call for price';const n=Number(String(value).replace(/[₹,\s]/g,''));return Number.isFinite(n)?'₹'+n.toLocaleString('en-IN',{maximumFractionDigits:2}):value;}
function cover(p){const photo=p.photos?.[0];return photo?(photo.url||previews.get(photo.path)||''):'';}
function render(){
  const live=drafts.filter(d=>d.publication==='published').length;
  $('summary').textContent=`${drafts.length} products · ${live} on your website · ${drafts.filter(d=>Catalogue.issues(d.data).length).length} need review`;
  document.querySelectorAll('[data-filter]').forEach(b=>{b.classList.toggle('active',b.dataset.filter===filter);b.querySelector('span').textContent=drafts.filter(d=>fits(d,b.dataset.filter)).length;});
  const list=visible();$('rows').replaceChildren();
  for(const d of list){
    const p=d.data,row=el('tr');const check=el('input');check.type='checkbox';check.checked=selected.has(d.id);check.setAttribute('aria-label',`Select ${p.name||'Untitled product'}`);check.onchange=()=>{check.checked?selected.add(d.id):selected.delete(d.id);renderBulk();};const tick=el('td');tick.append(check);row.append(tick);
    const cell=el('td'),product=el('div',null,'product-cell'),src=cover(p);
    if(src){const img=el('img',null,'thumb');img.src=src;img.alt='';img.loading='lazy';img.referrerPolicy='no-referrer';product.append(img);}else product.append(el('span','□','thumb thumb-empty'));
    const text=el('div'),open=el('button',p.name||'Untitled product','product-open');open.onclick=()=>perform(()=>openEditor(d.id),'Opening product…');text.append(open,el('span',[p.brand,p.model].filter(Boolean).join(' · '),'product-meta'));product.append(text);cell.append(product);row.append(cell);
    row.append(el('td',p.category||'—'),el('td',formatMoney(p.price)),el('td',p.inStock?'In stock':'Out of stock'));
    const state=Catalogue.status(d),stateCell=el('td');stateCell.append(el('span',state,'badge '+(state==='Published'?'good':state==='Changes to publish'?'warn':'')));row.append(stateCell);
    const missing=Catalogue.issues(p);row.append(el('td',missing.length?missing.join(' · '):'Ready','review '+(missing.length?'':'ready')));$('rows').append(row);
  }
  $('empty').hidden=list.length>0;$('row-count').textContent=`${list.length} of ${drafts.length} products`;renderBulk();
}
function renderBulk(){const list=visible();$('bulk').hidden=!selected.size;$('selected-count').textContent=`${selected.size} selected`;$('select-all').checked=list.length>0&&list.every(d=>selected.has(d.id));$('select-all').indeterminate=list.some(d=>selected.has(d.id))&&!$('select-all').checked;}
function field(name){return form.elements.namedItem(name);}
function fill(p){for(const name of ['name','brand','model','category','colour','size','price','mrp','description','sourceUrl']){const input=field(name);if(name==='category'&&p[name]&&![...input.options].some(o=>o.value===p[name]))input.add(new Option(p[name],p[name]));input.value=p[name]||'';}field('priceReviewed').checked=!!p.priceReviewed;field('inStock').checked=!!p.inStock;$('specs').value=Object.entries(p.specs||{}).map(([k,v])=>`${k}: ${v}`).join('\n');$('variants').value=(p.variants||[]).map(v=>[v.variant_type,v.variant_value,v.price||'',v.in_stock?'yes':'no',v.linked_product_id||''].join(' | ')).join('\n');}
function collect(){
  const p=clone(current.data);for(const name of ['name','brand','model','category','colour','size','description','sourceUrl'])p[name]=field(name).value.trim();
  p.price=Catalogue.price(field('price').value);p.mrp=Catalogue.price(field('mrp').value);p.priceReviewed=field('priceReviewed').checked;p.inStock=field('inStock').checked;p.specs={};
  for(const line of $('specs').value.split('\n')){if(!line.trim())continue;const at=line.indexOf(':');if(at<1)throw Error('Write each specification as “Name: value”.');p.specs[line.slice(0,at).trim()]=line.slice(at+1).trim();}
  p.variants=$('variants').value.split('\n').filter(s=>s.trim()).map(line=>{const [type,value,price,stock,linked]=line.split('|').map(x=>x.trim());if(!type||!value)throw Error('Each variant needs a type and value.');if(linked&&!/^\d+$/.test(linked))throw Error('A linked website ID must be a number.');return {variant_type:type,variant_value:value,price:Catalogue.price(price),in_stock:!/^(no|false|0)$/i.test(stock||'yes'),linked_product_id:linked||null};});
  return p;
}
function recoveryKey(){return `ee-catalogue-recovery:${current.id}`;}
function markDirty(){
  dirty=true;$('editor-note').textContent='Unsaved changes · Click Save draft to save across devices.';
  try{const p=collect();localStorage.setItem(recoveryKey(),JSON.stringify({revision:current.revision,data:p}));updateChecks(p);}catch{/* Invalid partial values stay in the form until corrected. */}
}
function updateChecks(p=current?.data){if(!p)return;const missing=Catalogue.issues(p);$('checks').textContent=missing.length?'Before publishing: '+missing.join(', '):'Ready to publish · Your draft is private until you publish.';$('checks').classList.toggle('ready',!missing.length);$('discount').textContent=p.mrp&&p.price&&Number(p.mrp)>Number(p.price)?`${Math.round((1-Number(p.price)/Number(p.mrp))*100)}% below MRP`:'';}
function updateEditorButtons(){if(!current)return;$('unpublish').hidden=current.publication!=='published';$('publish').textContent=current.website_id?'Publish update':'Publish';$('live-link').hidden=current.publication!=='published';$('live-link').href=`https://electricemporium.in/product-detail.html?id=${current.website_id}`;}
async function openEditor(draftId){
  const d=drafts.find(x=>x.id===draftId);current=d?clone(d):{id:crypto.randomUUID(),revision:0,publication:'draft',data:{name:'',brand:'',category:'',price:'',mrp:'',priceReviewed:false,inStock:false,photos:[],specs:{},variants:[],candidates:[],choices:[],stockIds:[]}};dirty=false;
  try{const recovery=JSON.parse(localStorage.getItem(recoveryKey())||'null');if(recovery?.revision===current.revision){current.data=recovery.data;dirty=true;}}catch{}
  fill(current.data);$('editor-title').textContent=current.data.name||'New product';$('editor-state').textContent=Catalogue.status(current).toUpperCase();$('editor-note').textContent=dirty?'Recovered unsaved changes from this device. Save draft to keep them.':'Draft edits are private until you publish.';$('stock-results').replaceChildren();$('stock-query').value='';$('image-url').value='';updateChecks();updateEditorButtons();
  if(!$('editor').open)$('editor').showModal();renderPhotos();renderCandidates();renderChoices();renderStockLinks();
  if(current.revision&&current.data.photos.some(p=>p.path)){const result=await api('sign',{id:current.id});result.photos.forEach(p=>{if(p.path&&p.preview)previews.set(p.path,p.preview);});renderPhotos();render();}
}
async function saveCurrent(){
  const p=collect();const result=await api('save',{id:current.id,revision:current.revision,data:p});
  localStorage.removeItem(recoveryKey());current=clone(result.draft);dirty=false;replaceDraft(result.draft);fill(current.data);updateChecks();updateEditorButtons();renderPhotos();renderCandidates();renderChoices();
  $('editor-title').textContent=current.data.name||'Untitled product';$('editor-state').textContent=Catalogue.status(current).toUpperCase();$('editor-note').textContent=result.duplicate?'This model already exists. Opened the existing product without overwriting it.':'Draft saved · '+new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'});
  if(result.duplicate)throw Error('This model already exists. Review the existing product before publishing.');return current;
}
async function publishCurrent(){await saveCurrent();const missing=Catalogue.issues(current.data);if(missing.length)throw Error('Complete the following first: '+missing.join(', '));const result=await api('publish',{id:current.id,revision:current.revision});current=clone(result.draft);replaceDraft(result.draft);updateEditorButtons();$('editor-state').textContent='PUBLISHED';notice('Published. Your product is now on the website.');}
async function closeEditor(){if(dirty){await saveCurrent();notice('Draft saved.');}$('editor').close();current=null;}
function renderPhotos(){
  $('photos').replaceChildren();(current.data.photos||[]).forEach((photo,index)=>{
    const card=el('div',null,'photo-card'),img=el('img');img.alt=`Catalogue photo ${index+1}`;const src=photo.url||previews.get(photo.path);if(src)img.src=src;img.referrerPolicy='no-referrer';card.append(img);if(index===0)card.append(el('span','COVER','cover'));
    const actions=el('div',null,'actions');if(index>0){const cover=el('button','Make cover');cover.type='button';cover.onclick=()=>{current.data.photos.splice(index,1);current.data.photos.unshift(photo);markDirty();renderPhotos();};actions.append(cover);}
    const remove=el('button','Remove');remove.type='button';remove.onclick=()=>{current.data.photos.splice(index,1);markDirty();renderPhotos();};actions.append(remove);card.append(actions);$('photos').append(card);
  });
}
async function addPhoto(blob){
  if(current.data.photos.length>=20)throw Error('Keep up to 20 photos per product.');
  const prepared=await prepare(blob);const path=`${current.id}/${prepared.sha256}.jpg`;
  if(current.data.photos.some(p=>p.path===path)){notice('That photo is already included.');return;}
  const bytes=new Uint8Array(await prepared.blob.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
  const result=await api('upload',{id:current.id,hash:prepared.sha256,base64:btoa(binary)});
  if(previews.has(result.path)&&previews.get(result.path).startsWith('blob:'))URL.revokeObjectURL(previews.get(result.path));previews.set(result.path,URL.createObjectURL(prepared.blob));current.data.photos.push({path:result.path});markDirty();renderPhotos();await saveCurrent();
}
async function addImage(url){const blob=await api('fetchImage',{url},true);await addPhoto(blob);}
function renderCandidates(){
  const candidates=current.data.candidates||[];$('candidates-section').hidden=!candidates.length;$('candidates').replaceChildren();
  candidates.forEach((url,index)=>{const card=el('div',null,'photo-card'),img=el('img');img.src=url;img.alt=`Source image ${index+1}`;img.loading='lazy';img.referrerPolicy='no-referrer';const keep=el('button','Keep this photo');keep.type='button';keep.onclick=()=>perform(async()=>{await addImage(url);current.data.candidates=current.data.candidates.filter(x=>x!==url);await saveCurrent();renderCandidates();},'Saving catalogue photo…');card.append(img,keep);$('candidates').append(card);});
}
function renderChoices(){const choices=current.data.choices||[];$('choices-section').hidden=!choices.length;$('choices').replaceChildren(new Option('Choose a colour / model…',''));choices.forEach((v,i)=>$('choices').add(new Option([v.sku,v.label].filter(Boolean).join(' · '),String(i))));}
function renderStockLinks(){const ids=current.data.stockIds||[];$('stock-links').replaceChildren();ids.forEach(stockId=>{const row=el('div',null,'stock-row');row.append(el('span','Linked stock item '+stockId.slice(0,8)));const remove=el('button','Unlink');remove.type='button';remove.onclick=()=>{current.data.stockIds=current.data.stockIds.filter(x=>x!==stockId);markDirty();renderStockLinks();};row.append(remove);$('stock-links').append(row);});}
async function preview(){
  const p=collect(),root=$('preview-content');root.replaceChildren();const content=el('div',null,'preview-product'),left=el('div'),right=el('div'),img=el('img');const src=cover(p);if(src)img.src=src;img.alt=p.name||'Product';left.append(img);right.append(el('p',p.brand,'eyebrow'),el('h3',p.name||'Untitled product'),el('p',formatMoney(p.price),'price'),el('p',p.inStock?'In stock':'Out of stock','badge '+(p.inStock?'good':'')),el('p',p.description||''));const specs=el('dl');for(const [k,v] of Object.entries({...p.specs,...(p.model?{Model:p.model}:{}),...(p.colour?{Colour:p.colour}:{}),...(p.size?{Size:p.size}:{})})){specs.append(el('dt',k),el('dd',v));}right.append(specs);content.append(left,right);root.append(content);$('preview-dialog').showModal();
}
async function bulkAction(action){
  const chosen=drafts.filter(d=>selected.has(d.id));const failures=[];let done=0;
  for(const d of chosen){try{if(action==='publish'&&Catalogue.issues(d.data).length)throw Error('Needs '+Catalogue.issues(d.data).join(', '));const result=await api(action,{id:d.id,revision:d.revision});replaceDraft(result.draft);selected.delete(d.id);done++;}catch(e){failures.push(`${d.data.name}: ${e.message}`);}}
  renderBulk();notice(`${done} product(s) ${action==='publish'?'published':'unpublished'}.`+(failures.length?' Still needs attention: '+failures.join(' / '):''),!!failures.length);
}
function renderQueue(){
  $('queue-list').replaceChildren();for(const job of jobs){const row=el('div',null,'queue-row'),text=el('div');text.append(el('strong',job.state==='failed'?'Could not import':job.state==='complete'?'Draft saved':'Waiting'),el('small',job.url));if(job.error)text.append(el('small',job.error));row.append(text);const action=el('button',job.state==='complete'?'Open draft':'Enter manually');action.onclick=()=>perform(async()=>{if(job.draft_id){$('importer').close();await openEditor(job.draft_id);}else{await openEditor();field('sourceUrl').value=job.url;markDirty();}},'Opening draft…');row.append(action);if(job.state!=='complete'){const dismiss=el('button','Dismiss');dismiss.onclick=()=>perform(async()=>{await api('job',{id:job.id,state:'complete'});jobs=jobs.filter(j=>j.id!==job.id);renderQueue();});row.append(dismiss);}$('queue-list').append(row);}
}
async function importDraft(data,forcedId){
  const duplicate=drafts.find(d=>Catalogue.key(d.data)&&Catalogue.key(d.data)===Catalogue.key(data));if(duplicate)return {draft:duplicate,duplicate:true};
  const result=await api('save',{id:forcedId||crypto.randomUUID(),revision:0,data});replaceDraft(result.draft);return result;
}
async function runQueue(){
  if(queueRunning)return;queueRunning=true;pauseQueue=false;let completed=0;
  try{for(const job of jobs.filter(j=>j.state!=='complete')){
    if(pauseQueue)break;$('import-progress').textContent=`Reading product ${completed+1} · ${job.url}`;
    try{const {html,finalUrl}=await api('fetchPage',{url:job.url});const c=extractProduct(html,finalUrl);c.specs={...c.specs,...readSpecsFromText(c)};const result=await importDraft(Catalogue.fromCandidate(c),job.id);await api('job',{id:job.id,state:'complete',draftId:result.draft.id});job.state='complete';job.draft_id=result.draft.id;job.error='';completed++;}
    catch(e){job.state='failed';job.error=e.message;await api('job',{id:job.id,state:'failed',error:e.message});}
    renderQueue();
  }}finally{queueRunning=false;$('import-progress').textContent=`${completed} draft(s) ready to review. ${jobs.filter(j=>j.state==='failed').length} link(s) need attention.`+(pauseQueue?' Queue paused.':'');render();}
}
async function addQueue(){const urls=[...new Set($('urls').value.split(/\s+/).map(x=>x.trim()).filter(Boolean))];if(!urls.length)throw Error('Paste at least one product link.');if(urls.some(u=>!/^https?:\/\//i.test(u)))throw Error('Each link must start with http:// or https://.');const pending=urls.filter(url=>!jobs.some(j=>j.url===url&&j.state!=='complete')).map(url=>({id:crypto.randomUUID(),url,state:'pending'}));await api('queue',{jobs:pending});jobs.push(...pending);$('urls').value='';renderQueue();await runQueue();}
async function importCSV(file){
  if(file.size>5*1024*1024)throw Error('Use a spreadsheet smaller than 5 MB.');
  let text;if(/\.xlsx?$/i.test(file.name)){
    if(!window.XLSX)await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='vendor/xlsx-0.20.3.min.js';script.onload=resolve;script.onerror=()=>reject(Error('Could not load the Excel reader. Refresh and try again.'));document.head.append(script);});
    const workbook=XLSX.read(await file.arrayBuffer(),{type:'array',sheetRows:1002,cellHTML:false});if(!workbook.SheetNames.length)throw Error('This workbook has no sheets.');
    text=XLSX.utils.sheet_to_csv(workbook.Sheets[workbook.SheetNames[0]]);
  }else text=await file.text();
  const rows=Catalogue.parseCSV(text);if(rows.length>1000)throw Error('Import up to 1,000 spreadsheet rows at a time.');let added=0,duplicates=0;const failed=[];
  for(const row of rows){$('import-progress').textContent=`Saving spreadsheet row ${row.row}…`;try{const result=await importDraft(row.data);result.duplicate?duplicates++:added++;}catch(e){failed.push(`Row ${row.row}: ${e.message}`);}}
  notice(`${added} drafts imported. ${duplicates} existing products skipped.`+(failed.length?' '+failed.join(' / '):''),!!failed.length);render();
}
async function importLens(){
  const data=await api('lens');let count=0,skipped=0;
  for(const p of data.products){if(drafts.some(d=>d.data.lensId===String(p.id))){skipped++;continue;}
    const photos=data.photos.filter(x=>x.product_id===p.id&&x.role==='catalogue');const product={name:p.name||'',brand:p.brand||'',model:p.model||'',category:Catalogue.category(p.category),colour:p.colour||'',size:p.size||'',description:p.description||'',price:p.price?String(p.price):'',mrp:'',priceReviewed:false,inStock:false,specs:p.specs||{},photos:[],variants:[],candidates:photos.map(photo=>`https://buzidwccluskdkccidev.supabase.co/storage/v1/object/public/ee-lens-photos/${photo.storage_path}`),lensId:String(p.id)};
    const result=await api('lensImport',{id:crypto.randomUUID(),lensId:p.id,category:product.category});replaceDraft(result.draft);result.duplicate?skipped++:count++;
  }
  notice(`${count} EE Lens drafts imported; ${skipped} existing products skipped. Review photos, prices and availability before publishing.`);
}
function bind(){
  for(const name of ['category-filter','bulk-category'])Catalogue.categories.forEach(c=>$(name).add(new Option(c,c)));Catalogue.categories.forEach(c=>field('category').add(new Option(c,c)));
  $('login-form').onsubmit=e=>{e.preventDefault();perform(async()=>{const {data,error}=await client.auth.signInWithPassword({email:$('email').value.trim(),password:$('password').value});if(error)throw error;if(data.user.id!==OWNER_ID){await client.auth.signOut();throw Error('Use the website owner account.');}$('password').value='';await showSession(data.session);},'Signing in…');};
  $('signout').onclick=()=>perform(async()=>{if(current&&dirty)await saveCurrent();await client.auth.signOut();location.reload();},'Signing out…');
  $('search').oninput=render;$('category-filter').onchange=render;document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;render();});
  $('refresh').onclick=()=>perform(load,'Refreshing catalogue…');$('new').onclick=()=>perform(()=>openEditor(),'Opening draft…');
  $('select-all').onchange=e=>{visible().forEach(d=>e.target.checked?selected.add(d.id):selected.delete(d.id));render();};$('clear-selection').onclick=()=>{selected.clear();render();};
  $('bulk-publish').onclick=()=>perform(()=>bulkAction('publish'),'Publishing selected products…');$('bulk-unpublish').onclick=()=>perform(()=>bulkAction('unpublish'),'Unpublishing selected products…');
  $('bulk-category').onchange=()=>perform(async()=>{const category=$('bulk-category').value;if(!category)return;const failures=[];for(const d of drafts.filter(x=>selected.has(x.id))){try{const result=await api('save',{id:d.id,revision:d.revision,data:{...d.data,category}});replaceDraft(result.draft);}catch(e){failures.push(`${d.data.name}: ${e.message}`);}}$('bulk-category').value='';notice(failures.length?failures.join(' / '):'Category saved to drafts. Publish when ready.',!!failures.length);});
  form.oninput=e=>{if(e.target.name==='price')field('priceReviewed').checked=false;markDirty();};form.onsubmit=e=>{e.preventDefault();perform(saveCurrent,'Saving draft…');};
  $('editor-close').onclick=()=>perform(closeEditor,'Saving draft…');$('editor').addEventListener('cancel',e=>{e.preventDefault();if(!working)perform(closeEditor,'Saving draft…');});
  $('publish').onclick=()=>perform(publishCurrent,'Publishing product…');$('unpublish').onclick=()=>perform(async()=>{if(dirty)await saveCurrent();const result=await api('unpublish',{id:current.id,revision:current.revision});current=clone(result.draft);replaceDraft(result.draft);updateEditorButtons();$('editor-state').textContent='UNPUBLISHED';notice('Unpublished. The draft is saved and can be published again.');},'Unpublishing product…');
  $('preview').onclick=()=>perform(preview,'Opening preview…');$('preview-close').onclick=()=>$('preview-dialog').close();
  $('photos-input').onchange=e=>perform(async()=>{for(const file of [...e.target.files]){if(file.size>20*1024*1024)throw Error('Choose images smaller than 20 MB.');await addPhoto(file);}e.target.value='';},'Preparing and saving photos…');
  $('image-add').onclick=()=>perform(async()=>{await addImage($('image-url').value.trim());$('image-url').value='';},'Downloading and saving photo…');
  $('choices').onchange=()=>{if($('choices').value==='')return;const v=current.data.choices[Number($('choices').value)];const p=collect();p.name=v.name||p.name;p.model=v.sku||p.model;p.colour=v.colour||p.colour;p.size=v.sizeSweepMm?`${v.sizeSweepMm} mm`:p.size;p.price=v.priceMinor?String(v.priceMinor/100):'';p.mrp=v.mrpMinor?String(v.mrpMinor/100):'';p.priceReviewed=false;p.variantReviewed=true;p.photos=[];p.candidates=v.images||[];current.data=p;fill(p);renderPhotos();renderCandidates();markDirty();};
  $('stock-search').onclick=()=>perform(async()=>{const {items}=await api('stock',{query:$('stock-query').value});$('stock-results').replaceChildren();items.forEach(item=>{const row=el('div',null,'stock-row');row.append(el('span',`${item.name} · ${item.qty} in stock · ${String(item.store_id).slice(0,8)}`));const button=el('button','Link');button.type='button';button.onclick=()=>{current.data.stockIds=[...new Set([...(current.data.stockIds||[]),item.id])];markDirty();renderStockLinks();};row.append(button);$('stock-results').append(row);});},'Finding stock items…');
  $('stock-sync').onclick=()=>perform(async()=>{const ids=current.data.stockIds||[];if(!ids.length)throw Error('Link at least one stock item first.');const {items}=await api('stock',{ids});if(items.length!==ids.length)throw Error('A linked stock item is missing. Check the links before updating availability.');const qty=items.reduce((sum,p)=>sum+Number(p.qty||0),0);field('inStock').checked=qty>0;markDirty();await saveCurrent();notice(`Linked stock: ${qty}. Draft availability updated. Publish to update the website.`);},'Reading linked stock…');
  $('import-open').onclick=()=>{$('importer').showModal();renderQueue();};$('import-close').onclick=()=>$('importer').close();$('queue-add').onclick=()=>perform(addQueue,'Importing products…');$('queue-resume').onclick=()=>perform(runQueue,'Importing products…');$('queue-pause').onclick=()=>{pauseQueue=true;$('import-progress').textContent='Will pause after the current product. Remaining links stay saved.';};
  $('csv').onchange=e=>{if(e.target.files[0])perform(()=>importCSV(e.target.files[0]),'Importing spreadsheet…');};$('lens-import').onclick=()=>perform(importLens,'Importing the EE Lens catalogue…');
  $('template').onclick=()=>{const text='Name,Brand,Model,Category,Colour,Size,Price,MRP,In stock,Description,Image URL,Source URL\r\n';const url=URL.createObjectURL(new Blob(['\uFEFF'+text],{type:'text/csv;charset=utf-8'}));const a=el('a');a.href=url;a.download='electric-emporium-products.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
}
async function showSession(session){const signed=!!session&&session.user.id===OWNER_ID;$('login').hidden=signed;$('workspace').hidden=!signed;$('signout').hidden=!signed;if(signed)await load();}
bind();client.auth.getSession().then(({data,error})=>{if(error)throw error;return showSession(data.session);}).catch(e=>{$('login').hidden=false;notice(e.message,true);});




