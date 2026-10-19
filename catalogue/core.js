/* Shared, dependency-free catalogue rules. Used in the browser and Node checks. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.Catalogue=api;})(globalThis,function(){
  'use strict';
  const categories=['Fans','Lights and LEDs','Fancy and Outdoor Lamps','Wires and Cables','Switches and Sockets','Switchgear and Industrial','Modular and Pipes','ACs and Freezers','Geysers','Appliances'];
  const aliases={'Wall Fans':'Fans','Pedestal Fans':'Fans','Exhaust Fans':'Fans','LEDs':'Lights and LEDs','Outdoor LEDs':'Fancy and Outdoor Lamps','Fancy Lamps':'Fancy and Outdoor Lamps','Wires/Cables':'Wires and Cables','Switches':'Switches and Sockets','Distribution Box':'Switchgear and Industrial','AC':'ACs and Freezers'};
  const appliance=/mixer|kettle|iron|induction|stabil|immersion/i;
  function category(v){return categories.find(c=>c.toLowerCase()===String(v||'').toLowerCase())||aliases[v]||(appliance.test(v)?'Appliances':'');}
  function normalize(v){return String(v||'').trim().toLowerCase().replace(/\s+/g,' ');}
  function key(p){return p.brand&&(p.model||p.name)?[p.brand,p.model||p.name,p.colour,p.size].map(normalize).join('|'):null;}
  function price(v){const s=String(v??'').trim().replace(/^(₹|Rs\.?|INR)\s*/i,'').replace(/,/g,'');if(!s)return '';if(!/^\d+(\.\d{1,2})?$/.test(s)||Number(s)<=0)throw Error('Enter a positive price, or leave it blank for “Call for price”.');return String(Number(s));}
  function issues(p){const a=[];if(!p.name?.trim())a.push('Name');if(!p.brand?.trim())a.push('Brand');if(!p.category?.trim())a.push('Category');if(!p.photos?.length)a.push('Photos');if(!p.priceReviewed)a.push('Price review');if(p.choices?.length&&!p.variantReviewed)a.push('Variant');return a;}
  function status(d){return d.publication==='published'?(d.revision===d.published_revision?'Published':'Changes to publish'):d.publication==='unpublished'?'Unpublished':'Draft';}
  function fromCandidate(c){return {name:c.name||'',brand:c.brand||'',model:c.model||'',category:category(c.category),colour:c.colour||'',size:c.sizeSweepMm?`${c.sizeSweepMm} mm`:'',description:c.description||'',price:c.priceMinor?String(c.priceMinor/100):'',mrp:c.mrpMinor?String(c.mrpMinor/100):'',priceReviewed:false,variantReviewed:false,inStock:false,sourceUrl:c.sourceUrl||'',specs:c.specs||{},photos:[],candidates:c.images||[],choices:c.variants||[],variants:[]};}
  function parseCSV(text){
    const rows=[];let row=[],cell='',quoted=false;
    text=String(text).replace(/^\uFEFF/,'');
    for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(!quoted&&(c===','||c==='\n'||c==='\r')){row.push(cell);cell='';if(c!==','){if(row.some(x=>x.trim()))rows.push(row);row=[];if(c==='\r'&&text[i+1]==='\n')i++;}}else cell+=c;}
    if(quoted)throw Error('The CSV has an unclosed quoted field.');row.push(cell);if(row.some(x=>x.trim()))rows.push(row);
    if(!rows.length)return [];const headers=rows.shift().map(x=>normalize(x).replace(/[ _-]/g,''));
    if(!headers.includes('name')&&!headers.includes('productname'))throw Error('The spreadsheet needs a Name or Product name column.');
    return rows.map((r,i)=>{const o={};headers.forEach((h,j)=>o[h]=r[j]||'');return {row:i+2,data:{name:o.name||o.productname||'',brand:o.brand||'',model:o.model||o.sku||'',category:category(o.category),colour:o.colour||o.color||'',size:o.size||'',description:o.description||'',price:price(o.price||o.sellingprice),mrp:price(o.mrp),priceReviewed:false,inStock:/^(yes|true|1|in stock)$/i.test(o.instock||''),sourceUrl:o.sourceurl||o.url||'',specs:{},photos:[],candidates:(o.imageurl||o.images||'').split('|').map(x=>x.trim()).filter(Boolean),variants:[]}};});
  }
  return {categories,category,key,normalize,price,issues,status,fromCandidate,parseCSV};
});
