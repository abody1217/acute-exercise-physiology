import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createBootstrapHandler } from '../functions/studio-bootstrap/handler.mjs';

const capability = 'a'.repeat(64); // Synthetic test value, never a deployed credential.
const hash = createHash('sha256').update(capability).digest('hex');
function fixture({ failLink = false, blockLink = null, expiresAt = new Date(Date.now()+60000).toISOString() } = {}) {
  const state = { stage:'ready', owner_email:'owner@example.test', claim:null, envelope:null, links:0, finishes:0, calls:0 };
  const admin = {
    auth: { admin: { generateLink: async () => {
      state.links++;
      if (blockLink) await blockLink;
      if (failLink) return { error:{ code:'unexpected_failure' } };
      return { data:{ user:{ id:'aaaaaaaa-0000-4000-8000-000000000001' }, properties:{ hashed_token:'deadbeef0123456789abcdef0123456789' } } };
    } } },
    rpc: async (name,args) => {
      state.calls++;
      if(name==='studio_bootstrap_claim') {
        if(state.stage==='working') return {error:{code:'PT409'}};
        if(state.stage==='complete') return {data:{completed:true,owner_email:state.owner_email,encrypted_result:state.envelope}};
        state.stage='working';state.claim=args.p_claim_id;
        return {data:{completed:false,owner_email:state.owner_email}};
      }
      if(name==='studio_bootstrap_finish') {
        assert.equal(args.p_claim_id,state.claim);
        state.finishes++;state.stage='complete';state.envelope=args.p_encrypted_result;
        return {data:true};
      }
      if(name==='studio_bootstrap_release') {
        if(state.stage==='working'&&state.claim===args.p_claim_id) state.stage='ready';
        return {data:true};
      }
      throw new Error('Unexpected RPC');
    },
  };
  return { state,handler:createBootstrapHandler({admin,ownerEmail:state.owner_email,capabilityHash:hash,expiresAt,siteUrl:'https://studio.example/'}) };
}
function req(token=capability,headers={}) {return new Request('https://project.supabase.co/functions/v1/studio-bootstrap',{method:'POST',headers:{'x-studio-setup':token,...headers}});}

test('unknown capability and website requests never touch bootstrap state',async()=>{
  const {handler,state}=fixture();
  assert.equal((await handler(req('b'.repeat(64)))).status,403);
  assert.equal((await handler(req(capability,{Origin:'https://studio.example'}))).status,403);
  assert.equal(state.calls,0);
});
test('expired deployment refuses a valid capability',async()=>{
  const {handler,state}=fixture({expiresAt:'2020-01-01T00:00:00Z'});
  assert.equal((await handler(req())).status,410);assert.equal(state.calls,0);
});
test('bootstrap creates owner once and can recover same sealed response',async()=>{
  const {handler,state}=fixture();
  const response=await handler(req());assert.equal(response.status,200);
  const first=await response.json();
  assert.equal(first.owner_email,'owner@example.test');assert.equal(new URLSearchParams(new URL(first.invite_url).hash.slice(1)).get('type'),'invite');
  assert.equal(JSON.stringify(state.envelope).includes('deadbeef'),false);
  assert.equal(JSON.stringify(state.envelope).includes('studio.example'),false);
  const retry=await handler(req());assert.equal(retry.status,200);assert.deepEqual(await retry.json(),first);
  assert.equal(state.links,1);assert.equal(state.finishes,1);
});
test('concurrent bootstrap requests cannot generate competing invitations',async()=>{
  let release;const blockLink=new Promise(resolve=>{release=resolve;});
  const {handler,state}=fixture({blockLink});
  const first=handler(req());
  while(!state.links) await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal((await handler(req())).status,409);
  release();assert.equal((await first).status,200);assert.equal(state.links,1);
});
test('failed provider generation releases claim without owner creation',async()=>{
  const {handler,state}=fixture({failLink:true});
  assert.equal((await handler(req())).status,503);
  assert.equal(state.stage,'ready');assert.equal(state.finishes,0);
});
