/* Browser integration test. All Supabase requests are intercepted; no production writes. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.CATALOGUE_TEST_URL||'http://127.0.0.1:8765/catalogue/';
const output=path.join(os.tmpdir(),'ee-catalogue-review');fs.mkdirSync(output,{recursive:true});
const owner='21e0db6b-373f-4793-93ac-b82ba79e569d';
const first='00000000-0000-4000-8000-000000000001';
let records=[{id:first,revision:1,published_revision:1,publication:'published',website_id:4,data:{name:'Test ceiling fan',brand:'Havells',model:'TEST-1200',category:'Fans',price:'2999',mrp:'3999',priceReviewed:true,inStock:true,description:'A test product for interface verification.',specs:{Sweep:'1200 mm'},photos:[{url:'https://images.example/product.jpg'}],variants:[]}}];
let jobs=[],saveFails=false,attempts={},published=0;
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const errors=[];const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await context.addInitScript(({owner})=>localStorage.setItem('ee-catalogue-owner',JSON.stringify({access_token:'test-session-only',refresh_token:'test-refresh-only',expires_at:Math.floor(Date.now()/1000)+36000,token_type:'bearer',user:{id:owner,email:'test@example.com'}})),{owner});
  await page.route('https://images.example/**',r=>r.fulfill({status:200,contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#eee"/><circle cx="60" cy="60" r="32" fill="#c8d4d1"/></svg>'}));
  await page.route('https://*.supabase.co/**',async route=>{
    if(!route.request().url().includes('/functions/v1/catalogue-manager'))return route.fulfill({status:400,json:{error:'Unexpected test request'}});
    const b=route.request().postDataJSON();const ok=v=>route.fulfill({json:v});const error=m=>route.fulfill({status:409,json:{error:m}});
    if(b.action==='list')return ok({drafts:records,jobs:jobs.filter(j=>j.state!=='complete')});
    if(b.action==='save'){
      if(saveFails)return error('Simulated save failure');let d=records.find(x=>x.id===b.id);
      if(d&&d.revision!==b.revision)return error('This product changed in another tab.');
      if(d){d.data=b.data;d.revision++;}else{d={id:b.id,revision:1,publication:'draft',data:b.data};records.push(d);}return ok({draft:d});
    }
    if(b.action==='publish'){const d=records.find(x=>x.id===b.id);d.publication='published';d.published_revision=d.revision;d.website_id=d.website_id||99;published++;return ok({draft:d});}
    if(b.action==='unpublish'){const d=records.find(x=>x.id===b.id);d.publication='unpublished';return ok({draft:d});}
    if(b.action==='queue'){jobs.push(...b.jobs);return ok({jobs:b.jobs});}
    if(b.action==='job'){const job=jobs.find(x=>x.id===b.id);Object.assign(job,{state:b.state,error:b.error,draft_id:b.draftId});return ok({job});}
    if(b.action==='fetchPage'){
      attempts[b.url]=(attempts[b.url]||0)+1;if(b.url.includes('retry')&&attempts[b.url]===1)return error('Source temporarily unavailable');
      return ok({finalUrl:b.url,html:'<html><head><script type="application/ld+json">'+JSON.stringify({'@type':'Product',name:b.url.includes('retry')?'Retry fan':'Imported fan',brand:{name:'Havells'},sku:b.url,offers:{price:'2499'},image:'https://images.example/product.jpg'})+'</script></head><body></body></html>'});
    }
    if(b.action==='lens')return ok({products:[],photos:[]});
    if(b.action==='upload')return ok({path:`${b.id}/${b.hash}.jpg`});
    if(b.action==='sign')return ok({photos:records.find(d=>d.id===b.id).data.photos});
    return error('Unhandled test action: '+b.action);
  });
  await page.goto(base);await page.getByRole('button',{name:'Test ceiling fan',exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(output,'catalogue-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'Test ceiling fan',exact:true}).click();
  await page.locator('[name=name]').fill('Edited test fan');await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await page.locator('#editor-note').filter({hasText:'Draft saved'}).waitFor();assert.equal(records[0].data.name,'Edited test fan');assert.equal(published,0);
  await page.getByRole('button',{name:'Preview',exact:true}).click();await page.locator('#preview-dialog').waitFor({state:'visible'});assert.equal(published,0);await page.locator('#preview-close').click();
  await page.locator('#publish').click();await page.locator('#editor-state').filter({hasText:'PUBLISHED'}).waitFor();assert.equal(published,1);
  await page.locator('#unpublish').click();await page.locator('#editor-state').filter({hasText:'UNPUBLISHED'}).waitFor();assert.equal(records[0].publication,'unpublished');
  await page.locator('[name=name]').fill('Unsaved test');saveFails=true;await page.locator('#save').click();await page.locator('#editor-note').filter({hasText:'Simulated save failure'}).waitFor();assert.equal(await page.locator('[name=name]').inputValue(),'Unsaved test');saveFails=false;
  await page.locator('#editor-close').click();await page.locator('#editor').waitFor({state:'hidden'});
  await page.locator('#import-open').click();await page.locator('#urls').fill('https://example.com/good\nhttps://example.com/retry');await page.locator('#queue-add').click();
  await page.locator('#import-progress').filter({hasText:'1 draft(s) ready'}).waitFor();assert.equal(jobs.filter(j=>j.state==='failed').length,1);
  await page.locator('#queue-resume').click();await page.locator('#import-progress').filter({hasText:'0 link(s) need attention'}).waitFor();assert.equal(attempts['https://example.com/good'],1);assert.equal(attempts['https://example.com/retry'],2);
  await page.locator('#import-close').click();await page.getByRole('button',{name:'Imported fan',exact:true}).click();
  await page.locator('#publish').click();await page.locator('#editor-note').filter({hasText:'Complete the following first'}).waitFor();assert.equal(published,1);
  await page.screenshot({path:path.join(output,'catalogue-editor.png')});
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh1sAAAAASUVORK5CYII=','base64');
  await page.locator('#photos-input').setInputFiles({name:'photo.png',mimeType:'image/png',buffer:png});
  await page.locator('#editor-note').filter({hasText:'Draft saved'}).waitFor();
  assert.equal(records.find(d=>d.data.name==='Imported fan').data.photos.length,1);
  await page.locator('[name=priceReviewed]').check();await page.locator('#publish').click();await page.locator('#editor-state').filter({hasText:'PUBLISHED'}).waitFor();assert.equal(published,2);
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'catalogue-mobile.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'No page overflow on mobile');
  await page.locator('#editor-close').click();await page.locator('#editor').waitFor({state:'hidden'});
  await page.locator('#select-all').check();await page.locator('#bulk-category').selectOption('Appliances');await page.locator('#notice').filter({hasText:'Category saved'}).waitFor();assert.ok(records.every(d=>d.data.category==='Appliances'));
  await page.locator('#import-open').click();
  const XLSX=require('../catalogue/vendor/xlsx-0.20.3.min.js');const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Name','Brand','Price','Category'],['Spreadsheet fan','Havells','4999','Fans']]),'Products');
  await page.locator('#csv').setInputFiles({name:'products.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(XLSX.write(wb,{type:'buffer',bookType:'xlsx'}))});
  await page.locator('#import-progress').filter({hasText:'1 drafts imported'}).waitFor();assert.equal(records.find(d=>d.data.name==='Spreadsheet fan').data.price,'4999');
  assert.deepEqual(errors,[]);await browser.close();console.log('Browser workflow passed: save, preview, publish/unpublish, failure recovery, queue retry, readiness, bulk edit, mobile. Screenshots: '+output);
})().catch(e=>{console.error(e);process.exit(1);});

