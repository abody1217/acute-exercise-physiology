import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { createBootstrapHandler } from './handler.mjs';
import { bootstrapConfig } from './deployment-config.ts';

let namedKeys: Record<string, string> = {};
try { namedKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}'); } catch (_) { /* Validated below. */ }
const serverKey = namedKeys.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const projectUrl = Deno.env.get('SUPABASE_URL');
if (!serverKey || !projectUrl) throw new Error('Server configuration is incomplete.');
const admin = createClient(projectUrl, serverKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(20000) }) },
});
Deno.serve(createBootstrapHandler({ admin, ...bootstrapConfig }));
