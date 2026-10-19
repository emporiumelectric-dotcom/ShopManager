'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const owner='21e0db6b-373f-4793-93ac-b82ba79e569d';
const merged={id:'00000000-0000-4000-8000-000000000001',data:{mergedInto:'00000000-0000-4000-8000-000000000002'}};
let reads=0;
const query={select(){return this;},eq(){return this;},async maybeSingle(){reads++;return {data:merged,error:null};}};
const admin={auth:{getUser:async()=>({data:{user:{id:owner}},error:null})},from:()=>query};
const context=vm.createContext({createClient:()=>admin,Deno:{env:{get:()=>''},serve:()=>{}},Response,Request,URL,AbortSignal,TextDecoder,Uint8Array,crypto:require('node:crypto').webcrypto});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../supabase/functions/catalogue-manager/index.js'),'utf8').replace(/^import .*\n/,''),context);
assert.equal(vm.runInContext("activeDrafts([{data:{}},{data:{mergedInto:'target'}}]).length",context),1);
assert.equal(vm.runInContext("sameLensProduct({data:{brand:'Havells',name:'Cera',colour:'Champagne',size:'1200 mm'}},{brand:'Havells',name:'Cera',colour:'Mist',size:'1200mm'})",context),false);
assert.equal(vm.runInContext("sameLensProduct({data:{brand:'Havells',name:'Cera',colour:'Mist',size:'1200 mm'}},{brand:'Havells',name:'Cera',colour:'Mist',size:'1200mm'})",context),true);
(async()=>{
 for(const action of ['save','publish','sign']){
  context.body=JSON.stringify({action,id:merged.id,revision:1,data:{name:'Old duplicate'}});
  const res=await vm.runInContext("handle(new Request('https://example.com',{method:'POST',headers:{Authorization:'Bearer owner'},body}))",context);
  assert.equal(res.status,409,action);assert.match((await res.json()).error,/merged/);
 }
 assert.equal(reads,3);
 console.log('Merged drafts stay out of the workspace, cannot be edited or published, and colour variants remain separate.');
})().catch(e=>{console.error(e);process.exitCode=1;});

