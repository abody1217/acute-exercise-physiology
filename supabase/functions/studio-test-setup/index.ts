// Temporary integration-test/seeding helper. Deploy only with a fresh random
// capability hash, exact synthetic accounts and expiry. Replace with 410 after QA.
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { setupConfig } from './deployment-config.ts';

let keys: Record<string,string> = {};
try { keys=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}'); } catch (_) { /* Checked below. */ }
const key=keys.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const url=Deno.env.get('SUPABASE_URL');
if(!url || !key || !/^[0-9a-f]{64}$/.test(setupConfig.capabilityHash)) throw new Error('Test setup is not configured.');
const admin=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
const sha=async(value:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',value)),b=>b.toString(16).padStart(2,'0')).join('');
const password=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('')+'Aa1!';
const check=(error:unknown)=>{if(error)throw new Error('Operation failed');};

Deno.serve(async request=>{
  const respond=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
  if(request.method!=='POST'||request.headers.has('origin'))return respond({error:'Unavailable'},403);
  if(Date.now()>=Date.parse(setupConfig.expiresAt))return respond({error:'Expired'},410);
  const token=request.headers.get('x-studio-setup')||'';
  if(!/^[0-9a-f]{64}$/.test(token))return respond({error:'Unavailable'},403);
  const digest=await sha(new TextEncoder().encode(token));let difference=0;
  for(let i=0;i<64;i++)difference|=digest.charCodeAt(i)^setupConfig.capabilityHash.charCodeAt(i);
  if(difference)return respond({error:'Unavailable'},403);
  const action=new URL(request.url).searchParams.get('action');
  try{
    if(action==='cleanup'){
      const removed=[];
      for(const account of setupConfig.tests){
        if(!account.id)throw new Error('Known test-user IDs required');
        const {data,error}=await admin.auth.admin.getUserById(account.id);
        if(error?.code==='user_not_found'){removed.push(account.email);continue;}
        check(error);
        if(data.user?.email!==account.email||data.user?.user_metadata?.studio_test_tag!==setupConfig.tag||account.email===setupConfig.ownerEmail)throw new Error('Account mismatch');
        check((await admin.from('studio_members').delete().eq('email',account.email)).error);
        check((await admin.auth.admin.deleteUser(account.id)).error);
        removed.push(account.email);
      }
      return respond({removed});
    }
    const {data:owner,error:ownerError}=await admin.from('studio_members').select('created_by,role').eq('email',setupConfig.ownerEmail).single();
    check(ownerError);if(!owner?.created_by||owner.role!=='admin')throw new Error('Owner must be bootstrapped first');
    if(action==='provision'){
      if(setupConfig.tests.some(account=>account.id))return respond({error:'Already provisioned'},409);
      const created:Array<{id:string,email:string,role:string|null,password:string}>=[];
      try{
        for(const account of setupConfig.tests){
          if(account.email===setupConfig.ownerEmail||!/^studio-smoke-(admin|editor|outsider)-[0-9a-f]+@example\.com$/.test(account.email)||![null,'admin','editor'].includes(account.role))throw new Error('Invalid test account');
          const secret=password();
          const {data,error}=await admin.auth.admin.createUser({email:account.email,password:secret,email_confirm:true,user_metadata:{studio_test_tag:setupConfig.tag}});
          check(error);if(!data.user?.id)throw new Error('Test user unavailable');
          created.push({id:data.user.id,email:account.email,role:account.role,password:secret});
          if(account.role)check((await admin.from('studio_members').insert({email:account.email,role:account.role,created_by:owner.created_by})).error);
        }
        return respond({accounts:created});
      }catch(_){
        for(const account of created){await admin.from('studio_members').delete().eq('email',account.email);await admin.auth.admin.deleteUser(account.id);}
        return respond({error:'Test-account setup failed; created accounts were scheduled for cleanup.'},503);
      }
    }
    if(action==='seed'){
      if(Number(request.headers.get('content-length'))>41943040)return respond({error:'Too large'},413);
      const bytes=new Uint8Array(await request.arrayBuffer());
      if(bytes.length>41943040||await sha(bytes)!==setupConfig.seed.sha256)return respond({error:'Seed content does not match deployment'},400);
      const {data:existing,error:lookupError}=await admin.from('presentations').select('id').eq('id',setupConfig.seed.id).maybeSingle();check(lookupError);
      if(existing)return respond({id:existing.id,already_present:true});
      const path=setupConfig.seed.id+'/original.html';
      const upload=await admin.storage.from('studio-originals').upload(path,bytes,{contentType:'text/html',upsert:false});
      if(upload.error && !['409','400'].includes(String(upload.error.statusCode)))throw new Error('Seed upload failed');
      // Confirm an object exists after a retry; never overwrite it.
      if(upload.error)check((await admin.storage.from('studio-originals').download(path)).error);
      const {data,error}=await admin.from('presentations').insert({id:setupConfig.seed.id,title:'Acute Exercise Physiology',original_filename:'Acute Exercise Physiology.html',slide_count:43,format:'html',original_path:path,created_by:owner.created_by,updated_by:owner.created_by}).select('id').single();check(error);
      return respond({id:data.id});
    }
    return respond({error:'Unsupported action'},400);
  }catch(_){return respond({error:'Setup operation failed.'},503);}
});
