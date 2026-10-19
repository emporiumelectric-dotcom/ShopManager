// Optional read-only network check: npx deno run -A scripts/check-catalogue-network.mjs
const source=(await Deno.readTextFile(new URL('../supabase/functions/catalogue-manager/index.js',import.meta.url))).replace(/^import .*\n/,'').replace('Deno.serve(handle);','');
const api=new Function('createClient',source+'\nreturn {download,ops,opsPhoto};')(()=>({}));
const page=await api.download('https://example.com');
if(!page.html.includes('Example Domain'))throw Error('Public page download failed.');
const products=await api.ops('products','select=id&deleted_at=is.null','ee_lens');
const photos=await api.ops('product_photos','select=storage_path&role=eq.catalogue&limit=1','ee_lens');
if(photos[0]){const bytes=await api.opsPhoto(photos[0].storage_path);if(!bytes.length)throw Error('Image download failed.');}
console.log(`Read-only network checks passed: public page, catalogue photo, ${products.length} active EE Lens products.`);
