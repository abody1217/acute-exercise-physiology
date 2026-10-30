// Temporary maintenance capability: fixed bytes to one immutable object path.
// This handler never edits presentation metadata and never returns credentials.
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
const same = (a,b) => { let difference=a.length^b.length; for(let i=0;i<a.length;i++) difference|=a.charCodeAt(i)^b.charCodeAt(i); return difference===0; };

export function createOriginalUploadHandler({admin,config}) {
  if(!new RegExp('^'+uuid+'$').test(config.presentationId) ||
     !new RegExp('^'+config.presentationId+'/original-'+uuid+'\\.html$').test(config.targetPath) ||
     config.expectedOriginalPath!==config.presentationId+'/original.html' ||
     !/^[0-9a-f]{64}$/.test(config.capabilityHash) || !/^[0-9a-f]{64}$/.test(config.sha256) ||
     !Number.isInteger(config.size) || config.size<1 || config.size>41943040 ||
     !Number.isInteger(config.expectedRevision) || config.expectedRevision<0 ||
     !Number.isInteger(config.expectedSlides) || config.expectedSlides<1 || config.expectedSlides>500 ||
     !Number.isFinite(Date.parse(config.expiresAt))) throw new Error('Invalid maintenance deployment.');
  const respond=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
  return async request => {
    if(request.method!=='POST'||request.headers.has('origin')) return respond({error:'Unavailable'},403);
    if(Date.now()>=Date.parse(config.expiresAt)) return respond({error:'Operation expired'},410);
    const token=request.headers.get('x-studio-operation')||'';
    if(!/^[0-9a-f]{64}$/.test(token)||!same(await digest(new TextEncoder().encode(token)),config.capabilityHash)) return respond({error:'Unavailable'},403);
    const contentLength=request.headers.get('content-length');
    if(contentLength!==null && Number(contentLength)!==config.size) return respond({error:'File size does not match'},400);
    if(!request.body) return respond({error:'File body required'},400);
    try {
      const reader=request.body.getReader(),chunks=[];let length=0;
      while(true) {
        const {done,value}=await reader.read();if(done)break;
        length+=value.byteLength;
        if(length>config.size){await reader.cancel();return respond({error:'File is too large'},413);}
        chunks.push(value);
      }
      const bytes=new Uint8Array(length);let offset=0;
      for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      if(length!==config.size||await digest(bytes)!==config.sha256)return respond({error:'File does not match approved bytes'},400);
      const current=await admin.from('presentations').select('id,original_path,revision,slide_count,patches').eq('id',config.presentationId).maybeSingle();
      if(current.error) return respond({error:'Could not inspect current presentation'},503);
      const row=current.data;
      if(!row||row.original_path!==config.expectedOriginalPath||row.revision!==config.expectedRevision||row.slide_count!==config.expectedSlides||JSON.stringify(row.patches)!=='{}') return respond({error:'Presentation changed; inspect it before continuing'},409);
      const bucket=admin.storage.from('studio-originals');
      const uploaded=await bucket.upload(config.targetPath,bytes,{contentType:'text/html',cacheControl:'31536000',upsert:false});
      // A retry may find the same immutable object. Read back its exact bytes;
      // any upload error is tolerated only when that same object verifies.
      const downloaded=await bucket.download(config.targetPath);
      if(downloaded.error||!downloaded.data) return respond({error:'Upload/readback failed; metadata was not changed'},503);
      const stored=new Uint8Array(await downloaded.data.arrayBuffer());
      if(stored.byteLength!==config.size||await digest(stored)!==config.sha256)return respond({error:'Stored object differs; metadata was not changed'},409);
      return respond({path:config.targetPath,size:config.size,sha256:config.sha256,already_present:Boolean(uploaded.error)});
    } catch (_) { return respond({error:'Maintenance operation failed; metadata was not changed'},503); }
  };
}
