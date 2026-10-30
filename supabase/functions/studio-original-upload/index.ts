import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { createOriginalUploadHandler } from './handler.mjs';
import { uploadConfig } from './deployment-config.ts';

let keys: Record<string,string> = {};
try { keys=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}'); } catch (_) { /* Checked below. */ }
const key=keys.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const url=Deno.env.get('SUPABASE_URL');
if(!url||!key)throw new Error('Server configuration unavailable.');
const admin=createClient(url,key,{
  auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
  global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(25000)})},
});
Deno.serve(createOriginalUploadHandler({admin,config:uploadConfig}));
