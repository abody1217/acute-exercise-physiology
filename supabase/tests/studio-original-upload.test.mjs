import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createOriginalUploadHandler } from '../functions/studio-original-upload/handler.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const capability='a'.repeat(64); // Synthetic fixture, never deployed.
const bytes=new TextEncoder().encode('<!doctype html><main>Approved replacement</main>');
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const path=id+'/original-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.html';
function fixture(options={}) {
  const config={presentationId:id,expectedOriginalPath:id+'/original.html',expectedRevision:3,expectedSlides:43,targetPath:path,size:bytes.length,sha256:hash(bytes),capabilityHash:hash(capability),expiresAt:new Date(Date.now()+60000).toISOString(),...options.config};
  const row={id,original_path:id+'/original.html',revision:3,slide_count:43,patches:{},...options.row};
  const state={lookups:0,uploads:0,stored:options.existing||null};
  const admin={
    from(name){assert.equal(name,'presentations');return {select(){return {eq(column,value){assert.equal(column,'id');assert.equal(value,id);return {async maybeSingle(){state.lookups++;return {data:row};}};}};}};},
    storage:{from(bucket){assert.equal(bucket,'studio-originals');return {
      async upload(target,value,uploadOptions){state.uploads++;assert.equal(target,path);assert.equal(uploadOptions.upsert,false);assert.equal(uploadOptions.contentType,'text/html');if(state.stored||options.failUpload)return {error:{statusCode:'409'}};state.stored=value;return {data:{path:target}};},
      async download(target){assert.equal(target,path);return state.stored?{data:new Blob([options.badReadback||state.stored])}:{error:{statusCode:'404'}};},
    };}},
  };
  return {handler:createOriginalUploadHandler({admin,config}),state};
}
function req({token=capability,body=bytes,headers={}}={}) {return new Request('https://project.example/functions/v1/studio-original-upload',{method:'POST',headers:{'x-studio-operation':token,...headers},body});}

test('unknown capability and browser origins cannot reach the database or storage',async()=>{
  const {handler,state}=fixture();assert.equal((await handler(req({token:'b'.repeat(64)}))).status,403);assert.equal((await handler(req({headers:{Origin:'null'}}))).status,403);assert.equal(state.lookups,0);assert.equal(state.uploads,0);
});
test('expired maintenance deployments deny the correct capability',async()=>{
  const {handler,state}=fixture({config:{expiresAt:'2020-01-01T00:00:00Z'}});assert.equal((await handler(req())).status,410);assert.equal(state.lookups,0);
});
test('changed bytes and oversized streams never touch storage',async()=>{
  const {handler,state}=fixture();const changed=bytes.slice();changed[0]=0;
  assert.equal((await handler(req({body:changed}))).status,400);assert.equal((await handler(req({body:new Uint8Array(bytes.length+1)}))).status,413);assert.equal(state.uploads,0);assert.equal(state.lookups,0);
});
test('a concurrent presentation edit stops staging',async()=>{
  for(const row of [{revision:4},{patches:{'s01-e0001-t0':{text:'New client edit'}}},{original_path:path},{slide_count:34}]) {
    const {handler,state}=fixture({row});assert.equal((await handler(req())).status,409);assert.equal(state.uploads,0);
  }
});
test('approved bytes are uploaded immutably and verified on readback',async()=>{
  const {handler,state}=fixture();const response=await handler(req());assert.equal(response.status,200);assert.deepEqual(await response.json(),{path,size:bytes.length,sha256:hash(bytes),already_present:false});assert.equal(state.uploads,1);
});
test('retry accepts an identical object but never replaces a differing one',async()=>{
  const identical=fixture({existing:bytes});const response=await identical.handler(req());assert.equal(response.status,200);assert.equal((await response.json()).already_present,true);
  const wrong=fixture({existing:new TextEncoder().encode('different')});assert.equal((await wrong.handler(req())).status,409);assert.equal(new TextDecoder().decode(wrong.state.stored),'different');
});
test('upload failure without verified bytes is not reported as success',async()=>{
  const failed=fixture({failUpload:true});assert.equal((await failed.handler(req())).status,503);
  const corrupted=fixture({badReadback:new TextEncoder().encode('corrupted')});assert.equal((await corrupted.handler(req())).status,409);
});
