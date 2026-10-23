import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { createStudioAccessHandler } from './handler.mjs';

const projectUrl = Deno.env.get('SUPABASE_URL');
const siteUrl = Deno.env.get('STUDIO_SITE_URL') || 'https://abody1217.github.io/acute-exercise-physiology/studio/';
let namedKeys: Record<string, string> = {};
try { namedKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}'); } catch (_) { /* Validated below. */ }
const serverKey = namedKeys.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!projectUrl || !serverKey || !siteUrl) throw new Error('Studio server configuration is incomplete.');

// Keep this service client separate from every user-scoped client. The caller's
// JWT is passed only to getUser; it never replaces the service authorization.
const admin = createClient(projectUrl, serverKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});
Deno.serve(createStudioAccessHandler({
  admin,
  siteUrl,
  allowedOrigins: (Deno.env.get('STUDIO_ALLOWED_ORIGINS') || '').split(',').map(value => value.trim()).filter(Boolean),
}));
