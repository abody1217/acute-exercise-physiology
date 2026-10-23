import { generateStudioInvitation } from '../_shared/invitations.mjs';
// Deliberately framework-free so the actual authorization boundary is testable.
// The injected client is server-only and must use a Supabase secret/service key.
const actions = new Set(['list', 'invite', 'update_role', 'revoke']);
const roles = new Set(['admin', 'editor']);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createStudioAccessHandler({ admin, siteUrl, allowedOrigins = [] }) {
  const redirect = new URL(siteUrl);
  if (redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(redirect.hostname))) {
    throw new Error('STUDIO_SITE_URL must use HTTPS.');
  }
  if (redirect.username || redirect.password || redirect.hash) throw new Error('Invalid STUDIO_SITE_URL.');
  redirect.searchParams.set('welcome', '1');
  const origins = new Set([redirect.origin, ...allowedOrigins]);
  if (origins.has('*') || origins.has('null')) throw new Error('Use exact Studio origins.');

  return async function handler(request) {
    const origin = request.headers.get('origin');
    const headers = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Pragma': 'no-cache',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Vary': 'Origin',
    });
    const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
    if (origin && !origins.has(origin)) return respond({ error: 'This origin is not allowed.', code: 'origin_denied' }, 403);
    if (origin) headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Headers', 'authorization, apikey, content-type, x-client-info');
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return respond({ error: 'Use POST.', code: 'method_not_allowed' }, 405);

    try {
      // getUser verifies the JWT with Auth. Decoding a token alone is not authentication.
      const authorization = request.headers.get('authorization') || '';
      if (!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(authorization) || authorization.length > 10000) {
        return respond({ error: 'Sign in to continue.', code: 'unauthorized' }, 401);
      }
      const { data: authData, error: authError } = await admin.auth.getUser(authorization.slice(7));
      const user = authData?.user;
      if (authError || !user?.id || !user.email || !user.email_confirmed_at || user.is_anonymous ||
          (user.banned_until && Date.parse(user.banned_until) > Date.now())) {
        return respond({ error: 'A verified account is required.', code: 'unauthorized' }, 401);
      }
      const actorEmail = user.email.trim().toLowerCase();
      const { data: membership, error: membershipError } = await admin.from('studio_members').select('role').eq('email', actorEmail).maybeSingle();
      if (membershipError) return respond({ error: 'Access could not be checked. Try again.', code: 'access_unavailable' }, 503);
      if (membership?.role !== 'admin') return respond({ error: 'Administrator access is required.', code: 'forbidden' }, 403);

      if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
        return respond({ error: 'Send a JSON request.', code: 'invalid_request' }, 400);
      }
      const declaredLength = Number(request.headers.get('content-length'));
      if (declaredLength > 4096) return respond({ error: 'Request is too large.', code: 'invalid_request' }, 413);
      // Bound streamed bodies as well; Content-Length can be absent or inaccurate.
      const reader = request.body?.getReader();
      const chunks = [];
      let length = 0;
      if (reader) {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 4096) {
            await reader.cancel();
            return respond({ error: 'Request is too large.', code: 'invalid_request' }, 413);
          }
          chunks.push(value);
        }
      }
      let body;
      try {
        body = JSON.parse(await new Blob(chunks).text());
      } catch (_) {
        return respond({ error: 'Invalid JSON request.', code: 'invalid_request' }, 400);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body) || !actions.has(body.action) ||
          Object.keys(body).some(key => !['action', 'email', 'role'].includes(key))) {
        return respond({ error: 'Invalid member action.', code: 'invalid_request' }, 400);
      }
      if (body.action === 'list') {
        const { data, error } = await admin.from('studio_members').select('email,role,created_at,updated_at').order('created_at', { ascending: true });
        if (error) return respond({ error: 'The member list is unavailable.', code: 'access_unavailable' }, 503);
        return respond({ members: data || [] });
      }

      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (email.length > 254 || !emailPattern.test(email) ||
          (body.action !== 'revoke' && !roles.has(body.role)) ||
          (body.action === 'revoke' && body.role !== undefined)) {
        return respond({ error: 'Enter a valid email and role.', code: 'invalid_request' }, 400);
      }
      if (email === actorEmail) return respond({ error: 'Your own account cannot be changed here.', code: 'self_change_denied' }, 400);
      const { data: member, error: changeError } = await admin.rpc('studio_manage_member', {
        p_actor_id: user.id, p_email: email, p_action: body.action,
        p_role: body.action === 'revoke' ? null : body.role,
      });
      if (changeError) {
        const statuses = { PT400: 400, PT403: 403, PT404: 404, PT409: 409 };
        const status = statuses[changeError.code] || 503;
        return respond({ error: status === 503 ? 'The access change could not be saved.' : changeError.message, code: changeError.code || 'access_unavailable' }, status);
      }
      if (body.action !== 'invite') return respond({ member });

      // generateLink never sends mail. The admin explicitly copies this bearer
      // invitation to the intended person. Never log/store the returned link.
      let invitation;
      try { invitation = await generateStudioInvitation(admin, email, redirect.href); } catch (_) {
        return respond({ error: 'Access was saved, but the invitation link could not be created. Retry the invite.', code: 'invite_link_failed', member }, 503);
      }
      return respond({ member, invite_url: invitation.invite_url, link_type: invitation.link_type });
    } catch (_) {
      // Do not print provider responses or tokens to function logs.
      return respond({ error: 'The access service is unavailable. Try again.', code: 'access_unavailable' }, 503);
    }
  };
}
