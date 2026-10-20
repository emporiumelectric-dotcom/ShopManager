/* Local UI rehearsal. All product/auth requests stay in memory; no cloud writes. */
'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),port=8766;
const fixture=String.raw`(() => {
  const owner='21e0db6b-373f-4793-93ac-b82ba79e569d';
  let state=JSON.parse(sessionStorage.getItem('fixture-state')||'null')||{records:[],jobs:[],attempts:{},lens:0,website:0,partial:false};
  const store=()=>{sessionStorage.setItem('fixture-state',JSON.stringify(state));const node=document.getElementById('fixture-status');if(node)node.textContent='LOCAL TEST · Lens saves '+state.lens+' · website publishes '+state.website;};
  window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:'local-fixture-only',user:{id:owner}}}})}})};
  const nativeFetch=window.fetch;
  window.fetch=async(url,options)=>{
    if(!String(url).includes('/functions/v1/catalogue-manager')){if(new URL(url,location.href).origin!==location.origin)throw Error('External access disabled in fixture');return nativeFetch(url,options);}
    const b=JSON.parse(options.body),ok=data=>{store();return Response.json(data);},error=message=>{store();return Response.json({error:message},{status:409});};
    if(b.action==='list')return ok({drafts:state.records,jobs:state.jobs.filter(j=>j.state!=='complete'),covers:[]});
    if(b.action==='checkBoth')return ok({ready:true});
    if(b.action==='queue'){state.jobs.push(...b.jobs);return ok({jobs:b.jobs});}
    if(b.action==='job'){Object.assign(state.jobs.find(j=>j.id===b.id),{state:b.state,error:b.error,draft_id:b.draftId});return ok({});}
    if(b.action==='fetchPage'){
      state.attempts[b.url]=(state.attempts[b.url]||0)+1;
      const n=Number(new URL(b.url).pathname.split('/').pop())||1;
      if(n===5&&state.attempts[b.url]===1)return error('Supplier temporarily unavailable. Retry this link.');
      const names=['Erica ceiling fan','Velora water heater','Studio exhaust fan','Cera ceiling fan','Power Hunk mixer'];
      const p={'@type':'Product',name:names[n-1],brand:{name:n%2?'Atomberg':'Havells'},sku:'DEMO-'+n,category:n===2?'Geysers':n===5?'Appliances':'Fans',color:'White',description:'Local test product. Check the model, colour and catalogue photo.',image:location.origin+'/__photo.jpg',offers:{price:'3999'}};
      if(n===4){p['@type']='ProductGroup';p.hasVariant=[{name:'Cera ceiling fan — Champagne',sku:'DEMO-4-C',color:'Champagne',size:'1200 mm',image:p.image},{name:'Cera ceiling fan — Mist',sku:'DEMO-4-M',color:'Mist',size:'1200 mm',image:p.image}];}
      return ok({html:'<html><head><script type="application/ld+json">'+JSON.stringify(p)+'</script></head><body></body></html>',finalUrl:b.url});
    }
    if(b.action==='save'){
      let d=state.records.find(d=>d.id===b.id);if(d&&d.revision!==b.revision)return error('This product changed. Reload.');
      if(!d){d={id:b.id,revision:0,publication:'draft'};state.records.push(d);}
      d.data=b.data;d.revision++;return ok({draft:d});
    }
    if(b.action==='fetchImage')return new Response(Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh1sAAAAASUVORK5CYII='),c=>c.charCodeAt(0)),{headers:{'Content-Type':'image/png'}});
    if(b.action==='upload')return ok({path:b.id+'/'+b.hash+'.jpg'});
    if(b.action==='sign')return ok({photos:state.records.find(d=>d.id===b.id).data.photos.map(p=>({...p,preview:location.origin+'/__photo.jpg'}))});
    if(['publishBoth','publish','publishLens'].includes(b.action)){
      const d=state.records.find(d=>d.id===b.id);if(d.revision!==b.revision)return error('Stale revision');
      if(b.action!=='publish'&&d.data.lensSyncedRevision!==d.revision){state.lens++;d.data.lensId=String(100+state.lens);d.data.lensSyncedRevision=d.revision;}
      if(b.action==='publishBoth'&&d.data.model==='DEMO-3'&&!state.partial){state.partial=true;return error('Saved to EE Lens; website publication is pending. Retry this row.');}
      if(b.action!=='publishLens'&&d.published_revision!==d.revision){state.website++;d.publication='published';d.published_revision=d.revision;d.website_id=200+state.website;}return ok({draft:d});
    }
    return error('Unhandled fixture action: '+b.action);
  };
  document.addEventListener('DOMContentLoaded',()=>{const bar=document.createElement('p');bar.id='fixture-status';bar.style='margin:0;padding:8px 24px;background:#fff3c9;font:12px sans-serif';document.body.prepend(bar);const reset=document.createElement('button');reset.textContent='Reset local rehearsal';reset.onclick=()=>{sessionStorage.removeItem('fixture-state');localStorage.removeItem('ee-catalogue-batch-review');location.reload();};document.body.prepend(reset);store();});
})();`;
http.createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/__source.html'&&process.env.CATALOGUE_SOURCE_FIXTURE){res.setHeader('Content-Type','text/plain');return res.end(fs.readFileSync(process.env.CATALOGUE_SOURCE_FIXTURE));}
  if(url.pathname.startsWith('/__website/')&&process.env.CATALOGUE_WEBSITE_FIXTURE){
    const base=path.resolve(process.env.CATALOGUE_WEBSITE_FIXTURE),file=path.resolve(base,'.'+url.pathname.slice('/__website'.length));
    if(!file.startsWith(base+path.sep)){res.writeHead(403);return res.end();}
    try{let body=fs.readFileSync(file);if(file.endsWith('product-detail.html'))body=body.toString().replace('<head>','<head><script src="/scripts/product-page-fixture.js"></script>');res.setHeader('Content-Type',path.extname(file)==='.html'?'text/html':path.extname(file)==='.js'?'text/javascript':'text/plain');return res.end(body);}catch{res.writeHead(404);return res.end();}
  }
  if(url.pathname==='/__fixture.js'){res.setHeader('Content-Type','text/javascript');return res.end(fixture);}
  if(url.pathname==='/__photo.jpg'){res.setHeader('Content-Type','image/svg+xml');return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 100"><rect width="120" height="100" fill="#f6f5f2"/><g fill="#777" transform="translate(60 50)"><ellipse rx="42" ry="7"/><ellipse rx="42" ry="7" transform="rotate(60)"/><ellipse rx="42" ry="7" transform="rotate(120)"/><circle r="12" fill="#bbb"/></g></svg>');}
  const file=path.resolve(root,'.'+decodeURIComponent(url.pathname)+(url.pathname.endsWith('/')?'index.html':''));
  if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
  try{let body=fs.readFileSync(file);if(file===path.join(root,'catalogue','index.html'))body=body.toString().replace('<script defer src="app.js">','<script defer src="/__fixture.js"></script><script defer src="app.js">');res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'})[path.extname(file)]||'application/octet-stream');res.end(body);}catch{res.writeHead(404);res.end();}
}).listen(port,'127.0.0.1',()=>console.log('Local-only batch rehearsal: http://127.0.0.1:'+port+'/catalogue/'));
