import {StudioUI} from './ui.js';
import {Cloud} from './cloud.js';
import {NAMESPACE,FORMAT,validEnvelope,validateItems,validatePatches,validateState,acceptChanges} from './bridge.js';
import {inspectHtml,buildHtml,setEditorRuntime} from './html-presentation.js';
import './styles.css';

let cloud,identity,current,authSubscription;
let opening=0,authLoading=false,runtime;
const SETUP_KEY='presentation-studio:password-setup';
// Capture fragment invitations before Supabase inspects location.hash. Remove
// bearer material before the first fetch, including legacy query links.
const callbackUrl=new URL(location.href);
const callbackHash=new URLSearchParams(callbackUrl.hash.slice(1));
let callbackToken=callbackHash.get('token_hash') || callbackUrl.searchParams.get('token_hash');
const callbackType=callbackHash.has('token_hash')?callbackHash.get('type'):callbackUrl.searchParams.get('type');
let welcome=callbackHash.get('welcome')==='1' || callbackUrl.searchParams.get('welcome')==='1';
if(callbackToken || welcome)history.replaceState(null,'',location.pathname);
const ui=new StudioUI({
  onRetry:start,
  onSignIn:async({email,password})=>{
    const {error}=await cloud.client.auth.signInWithPassword({email,password});
    if(error)throw error;
    ui.password.value='';
    await authenticated();
  },
  onSetPassword:async password=>{
    const {error}=await cloud.client.auth.updateUser({password});
    if(error)throw error;
    welcome=false;sessionStorage.removeItem(SETUP_KEY);ui.password.value='';ui.passwordConfirm.value='';
    await authenticated();
  },
  onSignOut:async()=>{
    if(!mayLeave())return false;
    const {error}=await cloud.client.auth.signOut({scope:'local'});
    if(error)throw error;
    signedOut();
  },
  onUpload:upload,
  onOpen:id=>openPresentation(id,false).catch(showError),
  onPresent:id=>openPresentation(id,true).catch(showError),
  onBack:()=>navigate('library').catch(showError),
  onNavigate:view=>navigate(view).catch(showError),
  onSave:()=>save(current),
  onTogglePresent:presenting=>setPresenting(presenting),
  onReloadPresentation:id=>openPresentation(id,false,{discard:true}),
  onDownloadOriginal:id=>downloadOriginal(id).catch(showError),
  onAddMember:invite,
  onInvite:invite,
  onRevokeMember:async member=>{await cloud.access({action:'revoke',email:member.email});await members();},
});

function showError(error) {ui.render({error:error?.message||'This action could not be completed.'});}
function workspace(partial) {ui.render({workspace:partial});}
function stateFor(doc,patches=doc.patches) {return {format:FORMAT,version:1,deckId:doc.row.id,documentId:doc.documentId,patches};}
function post(doc,type,detail={}) {
  doc.frame?.contentWindow?.postMessage({namespace:NAMESPACE,version:1,channel:doc.channel,type,deckId:doc.row.id,documentId:doc.documentId,...detail},'*');
  // Opaque sandbox origins require '*'; the target is this exact frame and
  // messages contain presentation patches only, never cloud credentials.
}
function mayLeave() {
  return !current?.dirty || window.confirm(current.saving
    ? 'A cloud save is in progress and may still finish. Leave without waiting? Any newer unsaved edits will be discarded.'
    : 'Some edits have not reached the cloud. Leave and discard those unsaved edits?');
}
function dispose() {
  opening++;
  if(current){current.closed=true;clearTimeout(current.timer);clearTimeout(current.readyTimer);current.viewer?.destroy();current.frame?.remove();current.images.clear();}
  current=null;ui.frameHost.replaceChildren();
}
function signedOut() {dispose();identity=null;welcome=false;sessionStorage.removeItem(SETUP_KEY);ui.render({view:'signin',authMode:'signin',user:null,role:null,presentations:[],members:[],error:'',notice:'',inviteUrl:''});}
async function start() {
  try {
    ui.render({view:'loading',error:'',notice:''});
    const config=await fetch(new URL('../config.json',import.meta.url),{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('Studio configuration could not be loaded.');return r.json();});
    if(!config.supabaseUrl||!config.publishableKey){ui.render({view:'configuring'});return;}
    if(!cloud){
      cloud=new Cloud(config);
      authSubscription=cloud.client.auth.onAuthStateChange(event=>{
        if(event==='SIGNED_OUT')signedOut();
        if(event==='PASSWORD_RECOVERY')welcome=true;
      }).data.subscription;
    }
    if(callbackToken){
      if(!['invite','magiclink','recovery'].includes(callbackType))throw new Error('This invitation link is invalid.');
      const {error}=await cloud.client.auth.verifyOtp({token_hash:callbackToken,type:callbackType});
      if(error)throw new Error('This invitation has expired or was already used. Ask the owner for a fresh invitation link.');
      callbackToken=null;
      welcome=true;
    }
    const {data,error}=await cloud.client.auth.getSession();
    if(error)throw error;
    if(!data.session){ui.render({view:'signin',authMode:'signin',user:null,role:null});return;}
    if(welcome)sessionStorage.setItem(SETUP_KEY,data.session.user.id);
    else welcome=sessionStorage.getItem(SETUP_KEY)===data.session.user.id;
    await authenticated();
  } catch(error){ui.render({view:'error',error:error.message});}
}
async function authenticated() {
  if(authLoading)return;
  authLoading=true;
  try {
    const {data,error}=await cloud.client.auth.getUser();
    if(error)throw error;
    identity=await cloud.identity();
    ui.render({user:data.user,role:identity?.role||null,error:'',notice:''});
    if(!identity){ui.render({view:'access'});return;}
    if(welcome){ui.render({view:'signin',authMode:'set-password'});return;}
    await library();
  } finally {authLoading=false;}
}
async function library() {
  const presentations=await cloud.list();
  ui.render({view:'library',presentations,error:'',notice:''});
}
async function members() {ui.render({view:'access',members:await cloud.members(),error:''});}
async function navigate(view) {
  if(welcome){ui.render({view:'signin',authMode:'set-password'});return;}
  if(!identity){await authenticated();return;}
  if(!mayLeave())return;
  dispose();
  if(view==='access'&&identity.role==='admin')await members();else await library();
}
async function invite({email,role}) {
  const data=await cloud.access({action:'invite',email,role:role||'editor'});
  await members();
  return {url:data.invite_url};
}
async function loadRuntime() {
  runtime ||= fetch(new URL('./editor-runtime.json',import.meta.url)).then(r=>{if(!r.ok)throw new Error('The presentation editor could not be loaded.');return r.json();}).then(setEditorRuntime).catch(error=>{runtime=null;throw error;});
  return runtime;
}
async function upload({file,title}) {
  if(identity?.role!=='admin')throw new Error('Only the owner can upload presentations.');
  if(!file||file.size>40*1024*1024||!file.size)throw new Error('Choose a presentation up to 40 MB.');
  const extension=file.name.split('.').pop().toLowerCase();
  const format=extension==='htm'?'html':extension;
  if(!['html','pdf','pptx'].includes(format))throw new Error('Choose an HTML, PDF or PowerPoint (.pptx) file.');
  const info=format==='html'?inspectHtml(await file.text()):await (await import('./native-viewer.js')).inspectNative(file,format);
  if(format==='html')info.patches=validatePatches(info.patches);
  const row=await cloud.create({id:crypto.randomUUID(),title:title.trim()||file.name.replace(/\.[^.]+$/,''),file,format,slideCount:info.slideCount});
  if(format==='html'&&Object.keys(info.patches||{}).length){
    try {const patches=await cloud.storeImages(row.id,info.patches,new Map());await cloud.save(row.id,patches,row.revision);}
    catch(error){await library();throw new Error(`The presentation was uploaded, but its imported edits could not be saved: ${error.message}`);}
  }
  await library();
  await openPresentation(row.id,false);
}
async function openPresentation(id,presenting,{discard=false}={}) {
  if(!discard&&!mayLeave())return;
  dispose();
  const epoch=opening;
  ui.render({view:'loading',loadingMessage:'Opening your presentation…',error:'',notice:''});
  const row=await cloud.get(id);
  const blob=await cloud.original(row);
  if(epoch!==opening)return;
  const doc={row,blob,closed:false,images:new Map(),patches:{},items:new Map(),channel:crypto.randomUUID(),documentId:`studio-${row.id}`,revision:0,savedRevision:0,dirty:false,saving:false,conflict:false};
  current=doc;
  workspace({id,title:row.title,editable:row.format==='html',presenting,dirty:false,isSaving:false,canSave:false,saveError:'',conflictMessage:'',canRetrySave:false,saveState:'Loading presentation…'});
  ui.render({view:'workspace'});
  if(row.format!=='html'){
    const native=await import('./native-viewer.js');
    if(current!==doc)return;
    doc.viewer=await native.mountNativeViewer(ui.frameHost,blob,row.format,{onError:error=>showError(error)});
    if(current!==doc){doc.viewer.destroy();return;}
    workspace({saveState:row.format==='pdf'?'PDF preview · fixed pages':'PowerPoint preview · download the original for full fidelity',canSave:false});
    doc.viewer.setPresenting?.(presenting);
    return;
  }
  const [html,patches]=await Promise.all([blob.text(),cloud.resolveImages(id,row.patches,doc.images),loadRuntime()]);
  if(current!==doc)return;
  doc.html=html;doc.patches=patches;
  const frame=document.createElement('iframe');
  frame.title=row.title;frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('allow','fullscreen');frame.referrerPolicy='no-referrer';
  frame.style.cssText='width:100%;height:100%;border:0;display:block;';
  doc.frame=frame;
  frame.srcdoc=buildHtml(html,{context:{channel:doc.channel,parentOrigin:location.origin,deckId:id,documentId:doc.documentId,patches,mode:presenting?'present':'edit'},patches,deckId:id,documentId:doc.documentId});
  ui.frameHost.replaceChildren(frame);
  doc.readyTimer=setTimeout(()=>{if(current===doc&&!doc.ready)workspace({saveError:'The presentation did not finish opening. Download the original or reload to try again.',canSave:false});},45000);
}
function setPresenting(presenting) {
  if(!current)return;
  workspace({presenting});post(current,'set-mode',{mode:presenting?'present':'edit'});current.viewer?.setPresenting?.(presenting);
}
window.addEventListener('message',event=>{
  const doc=current;
  if(!doc||!validEnvelope(event,doc))return;
  const data=event.data;
  try {
    if(data.type==='ready'){
      if(doc.ready)return;
      doc.items=validateItems(data.items,data.slideCount);
      doc.patches=validateState(stateFor(doc),doc).patches;
      doc.ready=true;clearTimeout(doc.readyTimer);
      workspace({saveState:'All changes saved',canSave:true,saveError:''});
      if(!data.loaded)post(doc,'load-state',{state:stateFor(doc)});
    } else if(['changes','save-request','download-request'].includes(data.type)){
      if(!doc.ready)return;
      const state=validateState(data.state,doc);
      if(data.type==='download-request'){
        downloadBackup(doc,data.kind,state);return;
      }
      if(!acceptChanges(doc,state,data.revision))return;
      workspace({dirty:doc.dirty,saveState:doc.conflict?'Cloud version changed':doc.dirty?'Saving shortly…':'All changes saved'});
      clearTimeout(doc.timer);
      if(data.type==='save-request')void save(doc);else if(!doc.conflict)doc.timer=setTimeout(()=>save(doc),900);
    } else if(data.type==='mode-change'&&['edit','present'].includes(data.mode))workspace({presenting:data.mode==='present'});
    else if(data.type==='state-error')throw new Error(String(data.message||'The saved presentation could not be loaded.').slice(0,2000));
  } catch(error){workspace({saveError:error.message,canSave:false});post(doc,'save-status',{kind:'error',message:error.message,revision:data.revision});}
});
async function save(doc) {
  if(!doc||current!==doc||doc.closed||doc.saving||doc.conflict||!doc.ready)return;
  if(!doc.dirty){workspace({saveState:'All changes saved'});post(doc,'save-status',{kind:'saved',message:'All changes saved to cloud.',revision:doc.revision});return;}
  clearTimeout(doc.timer);
  doc.saving=true;
  const revision=doc.revision,patches=structuredClone(doc.patches);
  workspace({isSaving:true,saveError:'',canRetrySave:false});post(doc,'save-status',{kind:'saving',message:'Saving to cloud…',revision});
  let succeeded=false;
  try {
    const stored=await cloud.storeImages(doc.row.id,patches,doc.images);
    if(doc.closed)return;
    doc.row=await cloud.save(doc.row.id,stored,doc.row.revision);
    doc.savedRevision=revision;doc.dirty=doc.revision>revision;succeeded=true;
    if(current===doc){workspace({dirty:doc.dirty,saveState:doc.dirty?'Saving newer edits…':'All changes saved',saveError:'',conflictMessage:''});post(doc,'save-status',{kind:'saved',message:'All changes saved to cloud.',revision});}
  } catch(error){
    if(current!==doc)return;
    doc.conflict=error.code==='PT409'||error.code==='409';
    const message=doc.conflict?'Someone saved a newer version. Download your changes as a backup, then load the cloud version before editing again.':`Edits are still in this tab. Save again when connected. ${error.message}`;
    workspace({saveError:message,conflictMessage:doc.conflict?message:'',canSave:!doc.conflict,canRetrySave:!doc.conflict,saveState:'Edits not saved',dirty:true});
    post(doc,'save-status',{kind:'error',message,revision});
  } finally {
    doc.saving=false;
    if(current===doc){workspace({isSaving:false});if(succeeded&&doc.dirty&&!doc.conflict)doc.timer=setTimeout(()=>save(doc),100);}
  }
}
function download(blob,filename){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
function downloadBackup(doc,kind,state){
  if(kind==='changes')download(new Blob([JSON.stringify(state,null,2)],{type:'application/json'}),'presentation-changes.json');
  else if(kind==='html')download(new Blob([buildHtml(doc.html,{patches:state.patches,documentId:crypto.randomUUID(),deckId:doc.row.id})],{type:'text/html'}),`${doc.row.title.replace(/[^\p{L}\p{N} _-]/gu,'').slice(0,100)||'presentation'}.html`);
}
async function downloadOriginal(id){const row=current?.row.id===id?current.row:await cloud.get(id);download(current?.row.id===id?current.blob:await cloud.original(row),row.original_filename);}
window.addEventListener('beforeunload',event=>{if(current?.dirty){event.preventDefault();event.returnValue='';}});
window.addEventListener('online',()=>{if(current?.dirty&&!current.conflict)void save(current);});
void start();
