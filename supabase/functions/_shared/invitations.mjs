// These are bearer links. Never log their content or include them in source.
export function studioInviteUrl(siteUrl, generated, requestedType) {
  const token = generated?.data?.properties?.hashed_token;
  const type = generated?.data?.properties?.verification_type || requestedType;
  if (generated?.error || typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,512}$/.test(token) || !['invite', 'magiclink'].includes(type)) {
    throw new Error('The invitation link could not be created.');
  }
  const url = new URL(siteUrl);
  url.search = '';
  // Fragments never reach static-host access logs or HTTP referrers.
  url.hash = new URLSearchParams({ welcome: '1', token_hash: token, type }).toString();
  return { invite_url: url.href, link_type: type };
}

export async function generateStudioInvitation(admin, email, siteUrl) {
  let linkType = 'invite';
  let generated = await admin.auth.admin.generateLink({ type: linkType, email });
  if (['email_exists', 'user_already_exists'].includes(generated.error?.code)) {
    linkType = 'magiclink';
    generated = await admin.auth.admin.generateLink({ type: linkType, email });
  }
  return { ...studioInviteUrl(siteUrl, generated, linkType), user_id: generated.data?.user?.id };
}
