export const NAMESPACE='presentation-editor-studio';
export const FORMAT='acute-exercise-editor';
const plain=value=>Boolean(value && typeof value==='object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value)));
const allowedEffects=new Set(['original','none','fade','up','down','left','right','zoom','pop']);
const ITEM_ID=/^s([0-9]{2,})-e[0-9]{4,}-(t[0-9]+|i|m)$/;
const typeFor=id=>{
  const match=typeof id==='string' && id.length<=100 && ITEM_ID.exec(id);
  return match ? match[2]==='i'?'image':match[2]==='m'?'motion':'text' : null;
};

export function validEnvelope(event,doc) {
  const data=event?.data;
  return Boolean(doc?.frame?.contentWindow && event?.isTrusted && event.source===doc.frame.contentWindow && event.origin==='null' && plain(data) &&
    data.namespace===NAMESPACE && data.version===1 && data.channel===doc.channel && data.deckId===doc.row.id &&
    data.documentId===doc.documentId && typeof data.type==='string' && Number.isSafeInteger(data.revision) && data.revision>=0);
}

/** Build the allow-list only from a complete, consistent ready message. */
export function validateItems(items,slideCount) {
  if(!Array.isArray(items)||items.length>30000||!Number.isInteger(slideCount)||slideCount<1||slideCount>500) throw new Error('This presentation has an invalid slide structure.');
  const map=new Map();
  for(const item of items) {
    const match=plain(item) && typeof item.id==='string' && ITEM_ID.exec(item.id);
    if(!match || typeFor(item.id)!==item.type || map.has(item.id) ||
      !Number.isInteger(item.slideIndex) || item.slideIndex<0 || item.slideIndex>=slideCount || Number(match[1])!==item.slideIndex+1 ||
      item.elementId!==item.id.replace(/-(t[0-9]+|i|m)$/,'')) throw new Error('The presentation returned an invalid editor item.');
    map.set(item.id,item.type);
  }
  for(const item of items) {
    if(item.type!=='motion' && (map.get(item.motionId)!=='motion' || !item.motionId.startsWith(item.id.split('-')[0]+'-'))) {
      throw new Error('The presentation returned an invalid animation target.');
    }
  }
  return map;
}

/** Without an item map this validates imported seeds before any cloud writes. */
export function validatePatches(patches,items=null) {
  if(!plain(patches)) throw new Error('Invalid presentation changes.');
  const entries=Object.entries(patches);
  if(entries.length>5000) throw new Error('The edits are too large to save.');
  const clean={};
  for(const [id,p] of entries) {
    const type=typeFor(id);
    if(!type || (items && items.get(id)!==type) || !plain(p)) throw new Error('Unknown slide element.');
    const keys=Object.keys(p);
    if(type==='text') {
      if(keys.some(k=>k!=='text')||typeof p.text!=='string'||p.text.length>10000) throw new Error('Invalid text edit.');
      clean[id]={text:p.text};
    } else if(type==='image') {
      if(keys.some(k=>!['src','alt'].includes(k))||typeof p.alt!=='string'||p.alt.length>2000||p.src!==undefined&&(typeof p.src!=='string'||p.src.length>14*1024*1024||!/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(p.src))) throw new Error('Invalid image edit.');
      clean[id]=p.src===undefined?{alt:p.alt}:{src:p.src,alt:p.alt};
    } else {
      if(keys.some(k=>!['effect','duration','delay'].includes(k))||!allowedEffects.has(p.effect)||!Number.isFinite(p.duration)||p.duration<100||p.duration>10000||!Number.isFinite(p.delay)||p.delay<0||p.delay>10000) throw new Error('Invalid motion setting.');
      clean[id]={effect:p.effect,duration:p.duration,delay:p.delay};
    }
  }
  if(JSON.stringify(clean).length>20*1024*1024) throw new Error('The edits are too large to save.');
  return clean;
}

export function validateState(state,doc) {
  if(!plain(state)||state.format!==FORMAT||state.version!==1||state.deckId!==doc.row.id||state.documentId!==doc.documentId) throw new Error('Invalid presentation changes.');
  return {format:FORMAT,version:1,deckId:doc.row.id,documentId:doc.documentId,patches:validatePatches(state.patches,doc.items)};
}

/** Same-revision retries must not silently replace already acknowledged edits. */
export function acceptChanges(doc,state,revision) {
  if(revision<doc.revision)return false;
  if(revision===doc.revision) {
    const left=Object.keys(doc.patches).sort(),right=Object.keys(state.patches).sort();
    if(left.length!==right.length || left.some((id,index)=>id!==right[index] || JSON.stringify(doc.patches[id])!==JSON.stringify(state.patches[id]))) {
      throw new Error('The presentation sent conflicting changes. Reload the cloud version before editing again.');
    }
    return true;
  }
  doc.patches=state.patches;doc.revision=revision;doc.dirty=revision>doc.savedRevision;
  return true;
}
