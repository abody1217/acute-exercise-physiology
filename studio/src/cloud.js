import {createClient} from '@supabase/supabase-js';
import {validatePatches} from './bridge.js';

const result = response => {
  if (response.error) throw Object.assign(new Error(response.error.message || 'The cloud request failed.'), {code:response.error.code});
  return response.data;
};
export function validateConfig(config) {
  if (!config?.supabaseUrl || !config?.publishableKey) return null;
  const url = new URL(config.supabaseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname!=='/') throw new Error('Invalid studio connection URL.');
  const key = config.publishableKey;
  if (typeof key!=='string') throw new Error('Only a public browser key may be used in the studio.');
  if (!key.startsWith('sb_publishable_')) {
    let payload;
    try { payload=JSON.parse(atob(key.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))); } catch {}
    if (payload?.role !== 'anon') throw new Error('Only a public browser key may be used in the studio.');
  }
  return {url:url.origin,key};
}
export class Cloud {
  constructor(config) {
    const valid=validateConfig(config);
    if (!valid) throw new Error('The studio connection has not been configured.');
    this.client=createClient(valid.url,valid.key,{auth:{storage:sessionStorage,persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  }
  async identity() { return result(await this.client.rpc('studio_identity')); }
  async list() {
    return result(await this.client.from('presentations').select('id,title,format,original_filename,slide_count,cover_path,updated_at').order('updated_at',{ascending:false}));
  }
  async get(id) { return result(await this.client.from('presentations').select('*').eq('id',id).single()); }
  async original(row) { return result(await this.client.storage.from('studio-originals').download(row.original_path)); }
  async create({id,title,file,format,slideCount}) {
    const originalPath=`${id}/original.${format}`;
    const mime={html:'text/html',pdf:'application/pdf',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation'}[format];
    result(await this.client.storage.from('studio-originals').upload(originalPath,file,{contentType:mime,upsert:false}));
    try {
      return result(await this.client.rpc('create_presentation',{p_id:id,p_title:title,p_original_filename:file.name,p_slide_count:slideCount,p_format:format,p_original_path:originalPath,p_cover_path:null}));
    } catch(error) {
      // A lost response may follow a committed insert. Delete only after the
      // server confirms that this presentation was not created.
      const check=await this.client.from('presentations').select('id').eq('id',id).maybeSingle();
      if (!check.error && check.data) return this.get(id);
      if (!check.error) await this.client.storage.from('studio-originals').remove([originalPath]);
      throw error;
    }
  }
  async save(id,patches,revision) {
    return result(await this.client.rpc('save_presentation',{p_id:id,p_patches:patches,p_expected_revision:revision}));
  }
  async members() { return (await this.access({action:'list'})).members; }
  async access(body) {
    const response=await this.client.functions.invoke('studio-access',{body});
    if(response.error) {
      let message;
      try {message=(await response.error.context.json()).error;} catch {}
      throw new Error(message || response.error.message || 'The access request failed.');
    }
    if(response.data?.error) throw new Error(response.data.error);
    return response.data;
  }
  async resolveImages(id,patches,cache) {
    const out={};
    for(const [key,patch] of Object.entries(patches || {})) {
      if(patch && Object.prototype.hasOwnProperty.call(patch,'asset')) {
        if(!validAssetPath(id,patch.asset) || !key.endsWith('-i') || Object.keys(patch).some(name=>!['asset','alt'].includes(name))) throw new Error('A saved image reference is invalid.');
        const blob=result(await this.client.storage.from('studio-images').download(patch.asset));
        if(blob.size>10*1024*1024) throw new Error('A saved image exceeds the 10 MB limit.');
        // Storage metadata is not always retained when objects are migrated.
        // Derive the expected MIME from the validated path, then check bytes.
        const mime='image/'+patch.asset.split('.').pop();
        const src=await blobDataUrl(new Blob([blob],{type:mime}));
        decodeImage(src);
        cache.set(src,patch.asset);
        out[key]={src,alt:patch.alt};
      } else out[key]=patch;
    }
    return validatePatches(out);
  }
  async storeImages(id,patches,cache) {
    const out={};
    for(const [key,patch] of Object.entries(validatePatches(patches))) {
      if(patch.src) {
        let asset=cache.get(patch.src);
        if(asset && !validAssetPath(id,asset)) throw new Error('A replacement image belongs to another presentation.');
        if(!asset) {
          const blob=decodeImage(patch.src);
          asset=`${id}/${crypto.randomUUID()}.${blob.type.slice(6)}`;
          result(await this.client.storage.from('studio-images').upload(asset,blob,{contentType:blob.type,upsert:false}));
          cache.set(patch.src,asset);
        }
        out[key]={asset,alt:patch.alt};
      } else out[key]=patch;
    }
    return out;
  }
}
function validAssetPath(id,path) {
  if(typeof path!=='string')return false;
  const parts=path.split('/');
  return parts.length===2 && parts[0]===id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpeg|gif|webp)$/.test(parts[1]);
}
export function blobDataUrl(blob) {
  return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reader.onabort=()=>reject(new Error('This image could not be read.'));reader.readAsDataURL(blob);});
}
export function decodeImage(src) {
  const match=/^data:(image\/(png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(src);
  if(!match || src.length>14*1024*1024) throw new Error('Use PNG, JPEG, GIF or WebP images up to 10 MB.');
  let bytes;
  try {bytes=Uint8Array.from(atob(match[3]),c=>c.charCodeAt(0));} catch {throw new Error('Invalid image data.');}
  const head=String.fromCharCode(...bytes.subarray(0,12));
  const valid={png:bytes[0]===137 && head.slice(1,8)==='PNG\r\n\x1a\n',jpeg:bytes[0]===255&&bytes[1]===216&&bytes[2]===255,gif:/^GIF8[79]a/.test(head),webp:head.startsWith('RIFF')&&head.slice(8,12)==='WEBP'};
  if(!valid[match[2]] || bytes.length>10*1024*1024) throw new Error('Invalid or oversized image file.');
  return new Blob([bytes],{type:match[1]});
}
