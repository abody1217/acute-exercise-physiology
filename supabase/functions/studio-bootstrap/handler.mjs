import { generateStudioInvitation } from '../_shared/invitations.mjs';
const encoder = new TextEncoder();
const asHex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const fromHex = text => new Uint8Array(text.match(/../g).map(value => parseInt(value, 16)));
const base64 = bytes => btoa(String.fromCharCode(...bytes));
const unbase64 = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));

async function resultKey(capability) {
  // A stored SHA-256(capability) is not an encryption key. Use the original
  // random capability with a separate HKDF context to seal retry responses.
  const material = await crypto.subtle.importKey('raw', fromHex(capability), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('presentation-studio-bootstrap-v1'), info: encoder.encode('result') },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt','decrypt']);
}
async function seal(value, capability) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await resultKey(capability), encoder.encode(JSON.stringify(value)));
  return { iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) };
}
async function unseal(envelope, capability) {
  const text = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(envelope.iv) }, await resultKey(capability), unbase64(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(text));
}

export function createBootstrapHandler({ admin, ownerEmail, capabilityHash, expiresAt, siteUrl }) {
  if (!/^[0-9a-f]{64}$/.test(capabilityHash) || !ownerEmail || !Number.isFinite(Date.parse(expiresAt))) throw new Error('Bootstrap configuration is incomplete.');
  return async request => {
    const headers = { 'Content-Type':'application/json', 'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer', 'X-Content-Type-Options':'nosniff' };
    const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
    // Operator-only HTTP call: never expose this setup capability to a website.
    if (request.method !== 'POST' || request.headers.has('origin')) return respond({ error: 'Setup is unavailable.' }, 403);
    if (Date.now() >= Date.parse(expiresAt)) return respond({ error: 'Setup has expired.' }, 410);
    const capability = request.headers.get('x-studio-setup') || '';
    if (!/^[0-9a-f]{64}$/.test(capability)) return respond({ error: 'Setup is unavailable.' }, 403);
    const digest = asHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(capability))));
    // Compare fixed-length digests without an early-out string comparison.
    let difference = 0;
    for (let i=0;i<64;i++) difference |= digest.charCodeAt(i) ^ capabilityHash.charCodeAt(i);
    if (difference !== 0) return respond({ error: 'Setup is unavailable.' }, 403);
    const claimId = crypto.randomUUID();
    let claimed = false;
    try {
      const { data: state, error: claimError } = await admin.rpc('studio_bootstrap_claim', { p_capability_hash: digest, p_claim_id: claimId });
      if (claimError) return respond({ error: claimError.code === 'PT409' ? 'Setup is already running or complete.' : 'Setup is unavailable.' }, claimError.code === 'PT409' ? 409 : 403);
      if (state.owner_email !== ownerEmail.toLowerCase().trim()) throw new Error('Owner mismatch');
      if (state.completed) return respond(await unseal(state.encrypted_result, capability));
      claimed = true;
      const invitation = await generateStudioInvitation(admin, ownerEmail, siteUrl);
      if (!invitation.user_id) throw new Error('Auth account missing');
      const result = { owner_email: ownerEmail, invite_url: invitation.invite_url, link_type: invitation.link_type };
      const encrypted = await seal(result, capability);
      const { error: finishError } = await admin.rpc('studio_bootstrap_finish', {
        p_claim_id: claimId, p_user_id: invitation.user_id, p_encrypted_result: encrypted,
      });
      if (finishError) throw new Error('Owner membership could not be committed');
      claimed = false;
      return respond(result);
    } catch (_) {
      if (claimed) {
        try { await admin.rpc('studio_bootstrap_release', { p_claim_id: claimId }); } catch (_) { /* Operator can inspect the private claim if the platform is unavailable. */ }
      }
      // Do not log errors containing provider bodies, capability, or invitation.
      return respond({ error: 'Setup did not finish. Retry the same setup request.' }, 503);
    }
  };
}
