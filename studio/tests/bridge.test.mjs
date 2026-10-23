import test from 'node:test';
import assert from 'node:assert/strict';
import {NAMESPACE,FORMAT,validEnvelope,validateItems,validatePatches,validateState,acceptChanges} from '../src/bridge.js';
import {validateConfig,decodeImage,Cloud} from '../src/cloud.js';

const deckId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const documentId='studio-'+deckId;
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6lPwAAAAASUVORK5CYII=';
const items=[
  {id:'s01-e0001-m',type:'motion',slideIndex:0,elementId:'s01-e0001'},
  {id:'s01-e0001-t0',type:'text',slideIndex:0,elementId:'s01-e0001',motionId:'s01-e0001-m'},
  {id:'s01-e0002-m',type:'motion',slideIndex:0,elementId:'s01-e0002'},
  {id:'s01-e0002-i',type:'image',slideIndex:0,elementId:'s01-e0002',motionId:'s01-e0002-m'},
];
const makeDoc=()=>({row:{id:deckId},documentId,channel:'random-channel-value',frame:{contentWindow:{}},items:validateItems(items,1),patches:{},revision:0,savedRevision:0,dirty:false});
const state=patches=>({format:FORMAT,version:1,deckId,documentId,patches});
const eventFor=doc=>({isTrusted:true,source:doc.frame.contentWindow,origin:'null',data:{namespace:NAMESPACE,version:1,type:'changes',channel:doc.channel,deckId,documentId,revision:1}});

test('envelope accepts only the trusted current opaque frame/channel/document',()=>{
  const doc=makeDoc(),valid=eventFor(doc);
  assert.equal(validEnvelope(valid,doc),true);
  for(const field of [{isTrusted:false},{source:{}},{origin:'https://example.org'},{origin:''}])assert.equal(validEnvelope({...valid,...field},doc),false);
  for(const field of [{namespace:'other'},{version:2},{channel:'other'},{deckId:'other'},{documentId:'old'},{revision:-1},{revision:1.5},{revision:Infinity}])assert.equal(validEnvelope({...valid,data:{...valid.data,...field}},doc),false);
  assert.equal(validEnvelope(valid,{...doc,frame:null}),false);
  assert.equal(validEnvelope(null,null),false);
});

test('ready metadata preserves actual text/image/motion suffixes and relationships',()=>{
  const map=validateItems(items,1);
  assert.equal(map.get('s01-e0001-t0'),'text');
  assert.equal(map.get('s01-e0002-i'),'image');
  assert.equal(map.get('s01-e0001-m'),'motion');
  assert.equal(validateItems([],1).size,0);
  for(const bad of [
    [...items,items[0]],
    items.map((item,index)=>index===1?{...item,type:'image'}:item),
    items.map((item,index)=>index===1?{...item,slideIndex:1}:item),
    items.map((item,index)=>index===1?{...item,elementId:'s01-e9999'}:item),
    items.map((item,index)=>index===1?{...item,motionId:'s01-e8888-m'}:item),
    [null],
  ])assert.throws(()=>validateItems(bad,1));
  assert.throws(()=>validateItems(items,0));
  assert.throws(()=>validateItems(items,501));
});

test('state schema matches editor and produces a fresh canonical root',()=>{
  const patches={'s01-e0001-t0':{text:'<script>literal text</script>'},'s01-e0002-i':{src:png,alt:'Replacement'},'s01-e0001-m':{effect:'fade',duration:1200,delay:350}};
  const input={...state(patches),unrelated:'do not forward'};
  const clean=validateState(input,makeDoc());
  assert.equal(clean.format,'acute-exercise-editor');
  assert.deepEqual(clean,state(patches));
  assert.notEqual(clean.patches,patches);
  assert.notEqual(clean.patches['s01-e0001-t0'],patches['s01-e0001-t0']);
  assert.deepEqual(validateState(state({'s01-e0002-i':{alt:''}}),makeDoc()).patches,{'s01-e0002-i':{alt:''}});
});

test('invalid imported seeds and changed frame states fail before storage',()=>{
  const doc=makeDoc();
  for(const patches of [
    {'s01-e9999-t0':{text:'unknown'}},
    {'s01-e0001-t0':{text:'x',html:'<b>x</b>'}},
    {'s01-e0001-t0':{text:'x'.repeat(10001)}},
    {'s01-e0001-t0':{src:png,alt:''}},
    {'s01-e0002-i':{src:'https://remote.example/image.png',alt:''}},
    {'s01-e0002-i':{src:'data:image/svg+xml;base64,PHN2Zz4=',alt:''}},
    {'s01-e0002-i':{asset:deckId+'/image.png',alt:''}},
    {'s01-e0001-m':{effect:'fade',duration:99,delay:0}},
    {'s01-e0001-m':{effect:'up',duration:1000,delay:Infinity}},
    {'s01-e0001-m':{effect:'evil',duration:1000,delay:0}},
    JSON.parse('{"__proto__":{"text":"x"}}'),
    [],
  ])assert.throws(()=>validateState(state(patches),doc));
  for(const fields of [{format:'wrong'},{version:2},{deckId:'other'},{documentId:'other'}])assert.throws(()=>validateState({...state({}),...fields},doc));
  assert.throws(()=>validatePatches({'bad-id':{text:'x'}}));
  assert.throws(()=>validatePatches(Object.fromEntries(Array.from({length:5001},(_,i)=>[`s01-e${String(i).padStart(4,'0')}-t0`,{text:'x'}]))));
});

test('newer edits remain dirty after an older save; stale/duplicate changes cannot replace them',()=>{
  const doc=makeDoc();
  const first=state({'s01-e0001-t0':{text:'First'}});
  const second=state({'s01-e0001-t0':{text:'Second'}});
  assert.equal(acceptChanges(doc,first,1),true);
  assert.equal(doc.dirty,true);
  assert.equal(acceptChanges(doc,second,2),true);
  doc.savedRevision=1;doc.dirty=doc.revision>doc.savedRevision;
  assert.equal(doc.dirty,true);
  assert.equal(acceptChanges(doc,first,1),false);
  assert.equal(doc.patches['s01-e0001-t0'].text,'Second');
  assert.throws(()=>acceptChanges(doc,first,2),/conflicting changes/);
  assert.equal(acceptChanges(doc,second,2),true);
  doc.savedRevision=2;doc.dirty=false;
  assert.equal(acceptChanges(doc,second,2),true);
  assert.equal(doc.dirty,false);
  assert.throws(()=>acceptChanges(doc,state({}),2));
});

test('browser connection accepts only public keys and project origins',()=>{
  const jwt=role=>'e30.'+Buffer.from(JSON.stringify({role})).toString('base64url')+'.sig';
  assert.equal(validateConfig({supabaseUrl:'https://example.supabase.co',publishableKey:jwt('anon')}).url,'https://example.supabase.co');
  assert.equal(validateConfig({supabaseUrl:'https://example.supabase.co/',publishableKey:'sb_publishable_test'}).key,'sb_publishable_test');
  for(const key of [jwt('service_role'),'sb_secret_test',123])assert.throws(()=>validateConfig({supabaseUrl:'https://example.supabase.co',publishableKey:key}));
  for(const url of ['http://example.supabase.co','https://user:password@example.supabase.co','https://example.supabase.co/path','https://example.supabase.co?key=x'])assert.throws(()=>validateConfig({supabaseUrl:url,publishableKey:'sb_publishable_test'}));
});

test('image bytes are validated even with a forged raster MIME',()=>{
  assert.equal(decodeImage(png).type,'image/png');
  assert.throws(()=>decodeImage('data:image/png;base64,'+Buffer.from('<svg onload="evil()"/>').toString('base64')));
  assert.throws(()=>decodeImage('data:image/svg+xml;base64,PHN2Zy8+'));
});

test('saved image paths cannot traverse or cross presentations before download',async()=>{
  let downloads=0;
  const fake={client:{storage:{from:()=>({download:async()=>{downloads++;throw new Error('must not download');}})}}};
  for(const asset of [null,123,deckId+'/../other/file.png','other/99999999-9999-4999-8999-999999999999.png',deckId+'/nested/file.png']) {
    await assert.rejects(()=>Cloud.prototype.resolveImages.call(fake,deckId,{'s01-e0002-i':{asset,alt:''}},new Map()));
  }
  assert.equal(downloads,0);
});
