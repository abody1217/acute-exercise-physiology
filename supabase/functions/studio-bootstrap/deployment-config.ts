// Replace these nonsecret placeholders in the deployment payload only.
// The raw 256-bit capability and resulting invite URL must never be committed.
export const bootstrapConfig = {
  ownerEmail: '__OWNER_EMAIL__',
  capabilityHash: '__CAPABILITY_SHA256__',
  expiresAt: '__EXPIRES_AT__',
  siteUrl: 'https://abody1217.github.io/acute-exercise-physiology/studio/',
};
