/* One review surface; no per-product editor is used by this workflow. */
(() => {
  const cacheKey='ee-catalogue-batch-review';
  let batchId='',rows=[],busy=false,changed=false;
  const stable=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
  const destination=()=>$('batch-destination').value;
  const destinationName=()=>({both:'both',website:'website',lens:'EE Lens'})[destination()];
  const finished=row=>!row.dirty&&!!row.draft&&(destination()==='lens'?row.draft.data.lensSyncedRevision===row.draft.revision:destination()==='website'?row.draft.publication==='published'&&row.draft.published_revision===row.draft.revision:row.draft.publication==='published'&&row.draft.published_revision===row.draft.revision&&row.draft.data.lensSyncedRevision===row.draft.revision);
  const featureText=p=>(p.features||[]).map(f=>f.title+(f.text?' | '+f.text:'')).join('\n');
  const parseFeatures=text=>text.split('\n').filter(s=>s.trim()).map(line=>{const at=line.indexOf('|');return {title:(at<0?line:line.slice(0,at)).trim(),text:at<0?'':line.slice(at+1).trim()};});
  function remember(){try{localStorage.setItem(cacheKey,JSON.stringify({batchId,rows,destination:destination()}));}catch{/* Saving to the server remains available. */}}
  function pending(row){
    if(!row.data)return [row.error||'Could not read this link'];
    const p=row.data,issues=Catalogue.issues({...p,priceReviewed:true,photos:[...(p.photos||[]),...(p.batchPhotoUrls||[])]});
    try{Catalogue.price(p.price);}catch{issues.push('Valid price');}
    if((p.photos?.length||0)+(p.batchPhotoUrls?.length||0)>20)issues.push('Up to 20 photos');
    return issues;
  }
  function summary(){
    const selectedRows=rows.filter(r=>r.selected&&!finished(r));
    const ready=selectedRows.filter(r=>!pending(r).length);
    const done=rows.filter(finished).length;
    $('batch-summary').textContent=rows.length?`${rows.length} products · ${ready.length} ready to publish · ${done} completed for ${destinationName()}`:'Your products will appear here.';
    $('batch-publish').textContent=`${destination()==='lens'?'Save':'Publish'} ${ready.length||'selected'} to ${destinationName()}`;
    $('batch-publish').disabled=busy||!ready.length||ready.length!==selectedRows.length||!$('batch-approved').checked;
    $('batch-select-all').checked=rows.some(r=>r.data&&!finished(r))&&rows.filter(r=>r.data&&!finished(r)).every(r=>r.selected);
    $('batch-empty').hidden=!!rows.length;
  }
  function edited(row){row.dirty=true;row.error='';changed=true;$('batch-approved').checked=false;remember();summary();}
  function input(row,key,label,type='text'){
    const wrap=el('label',label),field=el('input');field.type=type;field.value=row.data[key]||'';field.setAttribute('aria-label',`${label} — ${row.data.name||row.url}`);
    field.oninput=()=>{row.data[key]=field.value;edited(row);updateStatus(row);};wrap.append(field);return wrap;
  }
  function checkbox(label,checked,callback){const wrap=el('label',null,'check'),box=el('input');box.type='checkbox';box.checked=checked;box.onchange=()=>callback(box.checked);wrap.append(box,document.createTextNode(label));return wrap;}
  function status(row){return row.error|| (finished(row)?'Saved to '+destinationName():row.progress|| (pending(row).length?'Needs '+pending(row).join(', '):row.existing&&!row.selected?'Existing product · select to update':row.selected?'Ready for batch review':'On hold'));}
  function updateStatus(row){const node=document.getElementById('batch-status-'+row.id);if(node){node.textContent=status(row);node.className='batch-row-status '+(row.error?'error':finished(row)?'done':'');}}
  function renderPhotos(row,target){
    const p=row.data;target.replaceChildren();
    const gallery=el('div',null,'batch-gallery');
    const items=[...(p.photos||[]).map((photo,index)=>({src:photo.url||previews.get(photo.path)||'',photo,index})),...(p.candidates||[]).map(url=>({src:url,url}))];
    items.forEach((item,index)=>{
      const tile=el('label',null,'batch-photo'),img=el('img');img.src=item.src;img.alt=`${p.name} photo ${index+1}`;img.loading='lazy';img.referrerPolicy='no-referrer';
      const box=el('input');box.type='checkbox';box.checked=!!item.photo||(p.batchPhotoUrls||[]).includes(item.url);box.setAttribute('aria-label',`Keep photo ${index+1} for ${p.name}`);
      box.onchange=()=>{if(item.photo&&!box.checked){p.photos.splice(item.index,1);renderPhotos(row,target);}else if(item.url){p.batchPhotoUrls=box.checked?[...new Set([...(p.batchPhotoUrls||[]),item.url])]:(p.batchPhotoUrls||[]).filter(url=>url!==item.url);}edited(row);updateStatus(row);};
      tile.append(img,box);gallery.append(tile);
    });
    target.append(gallery,el('p','Checked photos are included. The first is the cover.','hint'));
    const entry=el('div',null,'inline'),url=el('input'),add=el('button','Add photo URL');url.type='url';url.placeholder='Add a missing photo URL';url.setAttribute('aria-label',`Photo URL — ${p.name}`);add.type='button';
    add.onclick=()=>{try{const parsed=new URL(url.value);if(!['https:','http:'].includes(parsed.protocol))throw Error();p.candidates=[...new Set([...(p.candidates||[]),parsed.href])].slice(0,20);p.batchPhotoUrls=[...new Set([...(p.batchPhotoUrls||[]),parsed.href])].slice(0,20);edited(row);renderPhotos(row,target);updateStatus(row);}catch{row.error='Enter a public image URL.';updateStatus(row);}};
    entry.append(url,add);target.append(entry);
  }
  function draw(){
    $('batch-rows').replaceChildren();
    for(const row of rows){
      const tr=el('tr');tr.dataset.batchRow=row.id;if(finished(row))tr.classList.add('batch-done');
      const selectCell=el('td'),box=el('input');box.type='checkbox';box.checked=row.selected;box.disabled=!row.data||finished(row);box.setAttribute('aria-label',`Include ${row.data?.name||row.url}`);box.onchange=()=>{row.selected=box.checked;$('batch-approved').checked=false;remember();summary();updateStatus(row);};selectCell.append(box);tr.append(selectCell);
      if(!row.data){const cell=el('td');cell.colSpan=4;cell.append(el('strong','Link needs attention'),el('p',row.url,'hint'),el('p',row.error||'Waiting to fetch…','batch-row-status error'));tr.append(cell);$('batch-rows').append(tr);continue;}
      const p=row.data,product=el('td'),photos=el('td'),pricing=el('td'),details=el('td');
      product.append(input(row,'name','Product name'));
      const pair=el('div',null,'batch-pair');pair.append(input(row,'brand','Brand'),input(row,'model','Model / SKU'));product.append(pair);
      if(p.choices?.length){
        const label=el('label','Exact variant'),choice=el('select');choice.setAttribute('aria-label',`Exact variant — ${p.name}`);choice.add(new Option('Choose colour / model…',''));
        p.choices.forEach((v,i)=>choice.add(new Option([v.sku,v.label||v.name].filter(Boolean).join(' · '),String(i))));choice.value=Number.isInteger(p.batchVariantIndex)?String(p.batchVariantIndex):'';
        choice.onchange=()=>{if(choice.value==='') {p.variantReviewed=false;delete p.batchVariantIndex;}else{const v=p.choices[Number(choice.value)];p.name=v.name||p.name;p.model=v.sku||p.model;p.colour=v.colour||'';p.size=v.sizeSweepMm?`${v.sizeSweepMm} mm`:'';p.photos=[];p.candidates=v.images||[];p.batchPhotoUrls=p.candidates.slice(0,1);p.variantReviewed=true;p.batchVariantIndex=Number(choice.value);}edited(row);draw();};label.append(choice);product.append(label);
      }
      const identity=el('div',null,'batch-pair');identity.append(input(row,'colour','Colour'),input(row,'size','Size / capacity'));product.append(identity);
      const source=el('a','Source product ↗','hint');source.href=row.url||p.sourceUrl;source.target='_blank';source.rel='noopener';product.append(source);
      const refreshDetails=el('details'),refreshTitle=el('summary','Change source / fetch again'),refresh=el('button','Refresh from source');refresh.type='button';
      refresh.onclick=()=>task(async()=>{
        const {html,finalUrl}=await api('fetchPage',{url:p.sourceUrl});const c=extractProduct(html,finalUrl);c.specs={...c.specs,...readSpecsFromText(c)};
        if(!c.name)throw Error('This source did not return a product. Your existing details were kept.');
        const fresh=Catalogue.fromCandidate(c);
        row.data={...p,...fresh,size:fresh.size||p.size,category:fresh.category||p.category,price:p.price,inStock:p.inStock,stockIds:p.stockIds,variants:p.variants,batchId,photos:[],batchPhotoUrls:(c.images||[]).slice(0,1),priceReviewed:false};
        row.url=finalUrl;row.selected=true;edited(row);$('batch-progress').textContent='Source refreshed. Check the new details and photos, then save the draft or publish to your chosen destination.';
      });
      refreshDetails.append(refreshTitle,input(row,'sourceUrl','Product source link','url'),el('p','Replaces fetched details and photos. Your selling price and availability are kept.','hint'),refresh);refreshDetails.querySelectorAll('input,button').forEach(control=>control.dataset.keepEnabled='true');product.append(refreshDetails);
      renderPhotos(row,photos);
      const priceField=input(row,'price','Selling price (₹)');priceField.querySelector('input').placeholder='Blank = Call for price';pricing.append(priceField,el('p','Blank means Call for price.','hint'));
      const catLabel=el('label','Category'),category=el('select');category.setAttribute('aria-label',`Category — ${p.name}`);category.add(new Option('Choose category…',''));Catalogue.categories.forEach(c=>category.add(new Option(c,c)));category.value=p.category||'';category.onchange=()=>{p.category=category.value;edited(row);updateStatus(row);};catLabel.append(category);pricing.append(catLabel);
      pricing.append(checkbox('Available in our shop',!!p.inStock,value=>{p.inStock=value;edited(row);}));
      const description=el('label','Description'),text=el('textarea');text.rows=3;text.value=p.description||'';text.setAttribute('aria-label',`Description — ${p.name}`);text.oninput=()=>{p.description=text.value;edited(row);};description.append(text);details.append(description);
      const features=el('label','Features'),featureInput=el('textarea');featureInput.rows=4;featureInput.value=featureText(p);featureInput.placeholder='One per line: Feature title | Explanation';featureInput.setAttribute('aria-label',`Features — ${p.name}`);featureInput.oninput=()=>{p.features=parseFeatures(featureInput.value);edited(row);};features.append(featureInput);details.append(features);
      const previewButton=el('button','Preview product');previewButton.type='button';previewButton.dataset.keepEnabled='true';previewButton.onclick=()=>previewProduct(p);details.append(previewButton);
      const specs=el('details'),specTitle=el('summary','Specifications'),specText=el('textarea');specText.rows=5;specText.value=Object.entries(p.specs||{}).map(([k,v])=>`${k}: ${v}`).join('\n');specText.setAttribute('aria-label',`Specifications — ${p.name}`);specText.oninput=()=>{p.specs={};for(const line of specText.value.split('\n')){const at=line.indexOf(':');if(at>0)p.specs[line.slice(0,at).trim()]=line.slice(at+1).trim();}edited(row);};specs.append(specTitle,specText);details.append(specs);
      const statusNode=el('p',status(row),'batch-row-status');statusNode.id='batch-status-'+row.id;details.append(statusNode);
      if(finished(row)){for(const cell of [product,photos,pricing,details])cell.querySelectorAll('input,select,textarea,button').forEach(control=>control.disabled=!control.dataset.keepEnabled);}
      tr.append(product,photos,pricing,details);$('batch-rows').append(tr);updateStatus(row);
    }
    summary();
  }
  function resumeOptions(){const ids=[...new Set([...drafts.map(d=>d.data.batchId),...jobs.map(j=>j.batch_id)].filter(Boolean))];$('batch-resume').replaceChildren(new Option('Choose a batch…',''));for(const value of ids){const items=drafts.filter(d=>d.data.batchId===value);$('batch-resume').add(new Option(`${items[0]?.data.name||'Unfinished links'} · ${items.length} products`,value));}}
  async function signPhotos(){for(const row of rows.filter(r=>r.data?.photos?.some(p=>p.path))){const result=await api('sign',{id:row.id});result.photos.forEach(p=>{if(p.path&&p.preview)previews.set(p.path,p.preview);});}draw();}
  async function restore(id){
    batchId=id;rows=drafts.filter(d=>d.data.batchId===id).map(d=>({id:d.id,url:d.data.sourceUrl,draft:clone(d),data:clone(d.data),selected:!(d.publication==='published'&&d.published_revision===d.revision&&d.data.lensSyncedRevision===d.revision)}));
    rows.push(...jobs.filter(j=>j.batch_id===id&&!rows.some(r=>r.id===j.id)).map(j=>({id:j.id,url:j.url,error:j.error,selected:false})));
    changed=false;$('batch-approved').checked=false;draw();remember();
    await signPhotos();
  }
  async function task(fn){
    if(busy||working)return;busy=true;$('batch-body').inert=true;$('batch-destination').disabled=true;$('batch-close').disabled=true;$('batch-save').disabled=true;$('batch-publish').disabled=true;
    try{await fn();}catch(e){$('batch-progress').textContent=e.message;}
    finally{busy=false;$('batch-body').inert=false;$('batch-destination').disabled=false;$('batch-close').disabled=false;$('batch-save').disabled=false;remember();draw();resumeOptions();}
  }
  async function fetchRows(targets){
    for(const row of targets){
      $('batch-progress').textContent=`Fetching ${targets.indexOf(row)+1} of ${targets.length}…`;row.error='';
      try{
        const {html,finalUrl}=await api('fetchPage',{url:row.url});const c=extractProduct(html,finalUrl);c.specs={...c.specs,...readSpecsFromText(c)};
        const p={...Catalogue.fromCandidate(c),batchId,price:'',priceReviewed:false,batchPhotoUrls:(c.images||[]).slice(0,1)};
        const result=await importDraft(p,row.id);
        if(rows.some(other=>other!==row&&other.draft?.id===result.draft.id)){row.error='This product is already included in another row.';row.selected=false;}
        else{row.id=result.draft.id;row.draft=clone(result.draft);row.data=clone(result.draft.data);row.existing=!!result.duplicate;row.selected=!result.duplicate;}
        const job=jobs.find(j=>j.url===row.url&&j.batch_id===batchId);if(job){await api('job',{id:job.id,state:'complete',draftId:result.draft.id});job.state='complete';job.draft_id=result.draft.id;}
      }catch(e){row.error=e.message;const job=jobs.find(j=>j.url===row.url&&j.batch_id===batchId);if(job){await api('job',{id:job.id,state:'failed',error:e.message});job.state='failed';job.error=e.message;}}
      remember();draw();
    }
    $('batch-progress').textContent='Check the rows below. Uncheck any product you want to hold.';
  }
  async function saveRow(row){
    const p=clone(row.data);p.price=Catalogue.price(p.price);p.batchId=batchId;
    if(stable(p)===stable(row.draft.data)){row.dirty=false;return;}
    const result=await api('save',{id:row.id,revision:row.draft.revision,data:p});
    if(result.duplicate)throw Error('This model already exists. Use its existing catalogue row.');
    row.draft=clone(result.draft);row.data=clone(result.draft.data);row.dirty=false;replaceDraft(result.draft);remember();
  }
  async function saveRows(){let count=0;for(const row of rows.filter(r=>r.data&&!finished(r)&&(!r.existing||r.selected))){try{await saveRow(row);count++;row.error='';}catch(e){row.error=e.message;}}changed=rows.some(r=>r.dirty);$('batch-progress').textContent=`${count} draft(s) saved. Nothing has been published.`;}
  async function preparePhotos(row){
    const chosen=[...(row.data.batchPhotoUrls||[])];
    for(const url of chosen){
      row.progress='Preparing catalogue photos…';updateStatus(row);
      const blob=await api('fetchImage',{url},true),prepared=await prepare(blob),bytes=new Uint8Array(await prepared.blob.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
      const result=await api('upload',{id:row.id,hash:prepared.sha256,base64:btoa(binary)});
      if(!row.data.photos.some(p=>p.path===result.path))row.data.photos.push({path:result.path});
      previews.set(result.path,URL.createObjectURL(prepared.blob));row.data.batchPhotoUrls=row.data.batchPhotoUrls.filter(x=>x!==url);row.data.candidates=row.data.candidates.filter(x=>x!==url);row.dirty=true;remember();
    }
  }
  async function publish(){
    const chosen=rows.filter(r=>r.selected&&!finished(r));if(!$('batch-approved').checked||!chosen.length||chosen.some(r=>pending(r).length))throw Error('Review the selected rows and complete missing details first.');
    let done=0;
    for(const row of chosen){
      try{
        $('batch-progress').textContent=`Publishing ${chosen.indexOf(row)+1} of ${chosen.length}: ${row.data.name}`;row.error='';
        await preparePhotos(row);row.data.priceReviewed=true;await saveRow(row);
        row.progress='Saving to '+destinationName()+'…';updateStatus(row);
        const result=await api(({both:'publishBoth',website:'publish',lens:'publishLens'})[destination()],{id:row.id,revision:row.draft.revision});row.draft=clone(result.draft);row.data=clone(result.draft.data);row.selected=false;row.dirty=false;row.progress='';replaceDraft(result.draft);done++;
      }catch(e){row.error=e.message;row.progress='';
        // A network timeout can happen after either destination committed. Re-read
        // the receipt so retries keep the same revision and destination identities.
        try{const fresh=await api('list');const d=fresh.drafts.find(x=>x.id===row.id);if(d){row.draft=clone(d);if(!row.dirty)row.data=clone(d.data);replaceDraft(d);}}catch{}
      }
      remember();draw();
    }
    changed=rows.some(r=>r.dirty);$('batch-approved').checked=false;
    $('batch-progress').textContent=`${done} product(s) saved to ${destinationName()}. ${rows.filter(r=>r.error).length} need attention. Unselected rows stay on hold.`;
  }
  $('batch-open').onclick=async()=>{resumeOptions();try{const saved=JSON.parse(localStorage.getItem(cacheKey)||'null');if(!rows.length&&saved?.batchId){batchId=saved.batchId;rows=saved.rows||[];if(['both','website','lens'].includes(saved.destination))$('batch-destination').value=saved.destination;for(const row of rows){const fresh=drafts.find(d=>d.id===row.id);if(fresh){if(row.draft?.revision!==fresh.revision){row.data=clone(fresh.data);row.dirty=false;}row.draft=clone(fresh);}}}}catch{}draw();$('batch-dialog').showModal();$('batch-connection').textContent='Checking both connections…';try{const result=await api('checkBoth');$('batch-connection').textContent=result.ready?'Connected to EE Lens and website.':'EE Lens connection needs attention.';await signPhotos();}catch(e){$('batch-connection').textContent=e.message;}};
  $('batch-close').onclick=()=>{remember();$('batch-dialog').close();};
  $('batch-dialog').addEventListener('cancel',e=>{if(busy)e.preventDefault();else remember();});
  $('batch-fetch').onclick=()=>task(async()=>{
    const urls=[...new Set($('batch-urls').value.split(/\s+/).map(x=>x.trim()).filter(Boolean))];
    if(!urls.length||urls.length>50)throw Error('Paste between 1 and 50 product links, one per line.');
    if(urls.some(url=>!/^https?:\/\//i.test(url)))throw Error('Each link must start with https:// or http://.');
    if(rows.some(r=>r.dirty)){await saveRows();if(rows.some(r=>r.dirty))throw Error('Save the current changes before starting another batch.');}
    batchId=crypto.randomUUID();rows=urls.map(url=>({id:crypto.randomUUID(),url,selected:false}));
    const queued=rows.map(r=>({id:r.id,url:r.url,state:'pending',batch_id:batchId}));await api('queue',{jobs:queued});jobs.push(...queued);remember();$('batch-urls').value='';$('batch-approved').checked=false;draw();await fetchRows(rows);
  });
  $('batch-resume').onchange=()=>task(async()=>{if(!$('batch-resume').value)return;if(rows.some(r=>r.dirty)){await saveRows();if(rows.some(r=>r.dirty))throw Error('Save the current changes first.');}await restore($('batch-resume').value);});
  $('batch-retry').onclick=()=>task(()=>fetchRows(rows.filter(r=>!r.data)));
  $('batch-save').onclick=()=>task(saveRows);$('batch-publish').onclick=()=>task(publish);
  $('batch-destination').onchange=()=>{$('batch-approved').checked=false;rows.forEach(r=>{r.selected=!!r.data&&!finished(r)&&!r.existing;});$('batch-progress').textContent='Destination: '+destinationName()+'. Review your selected rows before saving.';remember();draw();};
  $('batch-approved').onchange=summary;
  $('batch-select-all').onchange=e=>{rows.filter(r=>r.data&&!finished(r)).forEach(r=>r.selected=e.target.checked);$('batch-approved').checked=false;remember();draw();};
  $('batch-select-ready').onclick=()=>{rows.forEach(r=>r.selected=!!r.data&&!finished(r)&&!pending(r).length);$('batch-approved').checked=false;remember();draw();};
  $('batch-call-price').onclick=()=>{rows.filter(r=>r.selected&&!finished(r)).forEach(r=>{r.data.price='';edited(r);});draw();};
  Catalogue.categories.forEach(c=>$('batch-category').add(new Option(c,c)));
  $('batch-category').onchange=()=>{const category=$('batch-category').value;if(category)rows.filter(r=>r.selected&&!finished(r)).forEach(r=>{r.data.category=category;edited(r);});$('batch-category').value='';draw();};
  window.addEventListener('beforeunload',e=>{if(changed||busy){e.preventDefault();e.returnValue='';}});
})();
