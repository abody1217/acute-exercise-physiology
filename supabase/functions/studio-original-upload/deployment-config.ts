// Replace only in a temporary deployment payload. Never commit a raw capability.
export const uploadConfig: {
  presentationId:string; expectedOriginalPath:string; expectedRevision:number;
  expectedSlides:number; targetPath:string; size:number; sha256:string;
  capabilityHash:string; expiresAt:string;
} = __UPLOAD_CONFIG__;
