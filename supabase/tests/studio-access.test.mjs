import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioAccessHandler } from '../functions/studio-access/handler.mjs';

const owner = { id: '11111111-1111-4111-8111-111111111111', email: 'Owner@example.test', email_confirmed_at: '2026-10-23T00:00:00Z' };
const jwt = 'header.payload.signature';
function fixture(options = {}) {
  const calls = { tokens: [], rpc: [], links: [], membershipReads: 0 };
  let linkIndex = 0;
  const admin = {
    auth: {
      getUser: async token => { calls.tokens.push(token); return { data: { user: options.user === undefined ? owner : options.user }, error: options.authError }; },
      admin: { generateLink: async input => {
        calls.links.push(input);
        return options.linkResponses?.[linkIndex++] || { data: { properties: { hashed_token: '0123456789abcdef0123456789abcdef' } }, error: null };
      } },
    },
    from: table => {
      assert.equal(table, 'studio_members');
      return { select: columns => ({
        eq: (key, email) => ({ maybeSingle: async () => {
          calls.membershipReads++;
          assert.equal(columns, 'role'); assert.equal(key, 'email'); assert.equal(email, owner.email.toLowerCase());
          return { data: options.membership === undefined ? { role: 'admin' } : options.membership, error: null };
        } }),
        order: async () => ({ data: [{ email: 'client@example.test', role: 'editor', created_at: '2026-10-23T00:00:00Z' }], error: null }),
      }) };
    },
    rpc: async (name, args) => {
      calls.rpc.push({ name, args });
      return { data: { email: args.p_email, role: args.p_role, action: args.p_action }, error: options.rpcError };
    },
  };
  return {
    calls,
    handler: createStudioAccessHandler({ admin, siteUrl: 'https://abody1217.github.io/acute-exercise-physiology/studio/' }),
  };
}
function request(body, headers = {}) {
  return new Request('https://project.supabase.co/functions/v1/studio-access', {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json', Origin: 'https://abody1217.github.io', ...headers },
  });
}

test('missing or non-JWT auth is rejected before database access', async () => {
  const { handler, calls } = fixture();
  assert.equal((await handler(request({ action: 'list' }, { Authorization: 'Bearer sb_publishable_abc' }))).status, 401);
  assert.equal(calls.membershipReads, 0); assert.equal(calls.rpc.length, 0);
});
test('Auth server verification is required, not a decoded JWT claim', async () => {
  const { handler, calls } = fixture({ authError: { message: 'Invalid token' } });
  assert.equal((await handler(request({ action: 'invite', email: 'client@example.test', role: 'admin' }))).status, 401);
  assert.deepEqual(calls.tokens, [jwt]); assert.equal(calls.rpc.length, 0);
});
test('unconfirmed accounts cannot act as admin', async () => {
  const { handler, calls } = fixture({ user: { ...owner, email_confirmed_at: null } });
  assert.equal((await handler(request({ action: 'list' }))).status, 401);
  assert.equal(calls.membershipReads, 0);
});
test('verified editor cannot escalate role or list studio members', async () => {
  const { handler, calls } = fixture({ membership: { role: 'editor' } });
  assert.equal((await handler(request({ action: 'invite', email: 'client@example.test', role: 'admin' }))).status, 403);
  assert.equal((await handler(request({ action: 'list' }))).status, 403);
  assert.equal(calls.rpc.length, 0); assert.equal(calls.links.length, 0);
});
test('forged user metadata cannot override a missing allowlist membership', async () => {
  const { handler, calls } = fixture({ membership: null, user: { ...owner, user_metadata: { role: 'admin' } } });
  assert.equal((await handler(request({ action: 'list' }))).status, 403);
  assert.equal(calls.rpc.length, 0);
});
test('opaque or unrelated iframe origins cannot call the access endpoint', async () => {
  const { handler, calls } = fixture();
  for (const Origin of ['null', 'https://unrelated.example']) assert.equal((await handler(request({ action: 'list' }, { Origin }))).status, 403);
  assert.equal(calls.tokens.length, 0);
});
test('self revocation, unexpected role and caller-supplied redirect are rejected', async () => {
  const { handler, calls } = fixture();
  assert.equal((await handler(request({ action: 'revoke', email: owner.email }))).status, 400);
  assert.equal((await handler(request({ action: 'invite', email: 'client@example.test', role: 'owner' }))).status, 400);
  assert.equal((await handler(request({ action: 'invite', email: 'client@example.test', role: 'editor', redirectTo: 'https://bad.example' }))).status, 400);
  assert.equal(calls.rpc.length, 0);
});
test('a verified admin generates a manual link only after the authorized change commits', async () => {
  const { handler, calls } = fixture();
  const response = await handler(request({ action: 'invite', email: ' CLIENT@example.test ', role: 'editor' }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://abody1217.github.io');
  const payload = await response.json();
  assert.equal(payload.link_type, 'invite'); assert.match(payload.invite_url, /^https:\/\//);
  assert.deepEqual(calls.rpc[0], { name: 'studio_manage_member', args: {
    p_actor_id: owner.id, p_email: 'client@example.test', p_action: 'invite', p_role: 'editor',
  } });
  assert.deepEqual(calls.links[0], { type: 'invite', email: 'client@example.test' });
  assert.equal(payload.invite_url, 'https://abody1217.github.io/acute-exercise-physiology/studio/#welcome=1&token_hash=0123456789abcdef0123456789abcdef&type=invite');
  assert.equal(JSON.stringify(payload).includes(jwt), false);
});
test('existing account receives an explicit one-time magic link fallback', async () => {
  const { handler, calls } = fixture({ linkResponses: [ { data: null, error: { code: 'email_exists' } } ] });
  const response = await handler(request({ action: 'invite', email: 'client@example.test', role: 'editor' }));
  assert.equal(response.status, 200); assert.equal((await response.json()).link_type, 'magiclink');
  assert.deepEqual(calls.links.map(item => item.type), ['invite', 'magiclink']);
});
test('transactional denial prevents token generation and keeps the error status', async () => {
  const { handler, calls } = fixture({ rpcError: { code: 'PT409', message: 'Member already exists with a different role.' } });
  assert.equal((await handler(request({ action: 'invite', email: 'client@example.test', role: 'admin' }))).status, 409);
  assert.equal(calls.links.length, 0);
});
test('link generation failure reports saved membership without claiming success', async () => {
  const { handler } = fixture({ linkResponses: [{ data: null, error: { code: 'unexpected_failure' } }] });
  const response = await handler(request({ action: 'invite', email: 'client@example.test', role: 'editor' }));
  assert.equal(response.status, 503);
  const payload = await response.json(); assert.equal(payload.code, 'invite_link_failed'); assert.equal(payload.member.role, 'editor');
});
test('member revoke never calls the Auth invitation API', async () => {
  const { handler, calls } = fixture();
  const response = await handler(request({ action: 'revoke', email: 'client@example.test' }));
  assert.equal(response.status, 200); assert.equal(calls.rpc[0].args.p_role, null); assert.equal(calls.links.length, 0);
});
test('oversized streamed bodies are refused even without content length', async () => {
  const { handler, calls } = fixture();
  assert.equal((await handler(request('{"action":"list","padding":"' + 'a'.repeat(5000) + '"}'))).status, 413);
  assert.equal(calls.rpc.length, 0);
});
