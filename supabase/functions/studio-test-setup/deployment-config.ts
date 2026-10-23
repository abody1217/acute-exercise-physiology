// Fill only in the deployment payload. Never add test passwords or raw tokens.
export const setupConfig: {
  ownerEmail:string; capabilityHash:string; expiresAt:string; tag:string;
  seed:{id:string;sha256:string};
  tests:Array<{email:string;role:'admin'|'editor'|null;id?:string}>;
} = __SETUP_CONFIG__;
