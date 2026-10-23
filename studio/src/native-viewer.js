import { Inflate } from 'fflate';

const MAX_FILE_BYTES = 40 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 200 * 1024 * 1024;
const MAX_SLIDES = 500;
const MAX_ENTRIES = 12000;
const MAX_XML_BYTES = 16 * 1024 * 1024;
const decoder = new TextDecoder();
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
let pdfModulePromise;
let pptxModulesPromise;

const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};
const limitError = message => new Error(message);

async function readBytes(file) {
  const size = file?.size ?? file?.byteLength;
  if (!Number.isFinite(size) || size < 1) throw limitError('Choose a non-empty PowerPoint or PDF file.');
  if (size > MAX_FILE_BYTES) throw limitError('Presentations must be 40 MB or smaller.');
  if (file instanceof Uint8Array) return new Uint8Array(file);
  if (file instanceof ArrayBuffer) return new Uint8Array(file.slice(0));
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  throw limitError('This presentation file could not be read.');
}

function normalizeFormat(format) {
  const value = String(format || '').toLowerCase().replace(/^\./, '');
  if (value !== 'pdf' && value !== 'pptx') throw limitError('The native viewer supports PowerPoint (.pptx) and PDF files.');
  return value;
}

// Validate both declared ZIP sizes and actual streamed output before the PPTX
// parser may allocate its complete package. No archive files touch the filesystem.
export async function validatePptxZip(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_FILE_BYTES || bytes.length < 22) throw limitError('This PowerPoint archive is invalid or too large.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = offset => view.getUint16(offset, true);
  const u32 = offset => view.getUint32(offset, true);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (u32(offset) === 0x06054b50 && offset + 22 + u16(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0) throw limitError('This file is not a complete PowerPoint archive.');
  const count = u16(end + 10);
  const directorySize = u32(end + 12);
  const directoryOffset = u32(end + 16);
  if (u16(end + 4) !== 0 || u16(end + 6) !== 0 || u16(end + 8) !== count || count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw limitError('Split or ZIP64 PowerPoint archives are not supported.');
  }
  if (!count || count > MAX_ENTRIES || directoryOffset + directorySize !== end) throw limitError('This PowerPoint archive has an invalid directory.');
  const entries = [];
  const names = new Set();
  let offset = directoryOffset;
  let declaredTotal = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || u32(offset) !== 0x02014b50) throw limitError('This PowerPoint archive is damaged.');
    const flags = u16(offset + 8);
    const method = u16(offset + 10);
    const compressed = u32(offset + 20);
    const expanded = u32(offset + 24);
    const nameLength = u16(offset + 28);
    const extraLength = u16(offset + 30);
    const commentLength = u16(offset + 32);
    const disk = u16(offset + 34);
    const localOffset = u32(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end || !nameLength || nameLength > 1024 || disk !== 0 || flags & 1 || ![0, 8].includes(method)) throw limitError('Encrypted or unsupported PowerPoint archives cannot be previewed.');
    if ([compressed, expanded, localOffset].includes(0xffffffff)) throw limitError('ZIP64 PowerPoint archives are not supported.');
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = decoder.decode(nameBytes);
    if (names.has(name) || /[\x00\\]/.test(name) || name.startsWith('/') || name.split('/').includes('..') || /^[a-z]:/i.test(name)) throw limitError('This PowerPoint archive contains invalid file paths.');
    names.add(name);
    declaredTotal += expanded;
    if (declaredTotal > MAX_EXPANDED_BYTES) throw limitError('This PowerPoint expands beyond the 200 MB preview limit.');
    if (/\.(xml|rels)$/i.test(name) && expanded > MAX_XML_BYTES) throw limitError('A slide or document structure is too large to preview safely.');
    if (name === 'ppt/presentation.xml' && expanded > 4 * 1024 * 1024) throw limitError('This PowerPoint presentation structure is too large.');
    if (method === 0 && compressed !== expanded) throw limitError('This PowerPoint archive has inconsistent file sizes.');
    if (localOffset + 30 > directoryOffset || u32(localOffset) !== 0x04034b50) throw limitError('This PowerPoint archive has an invalid file header.');
    const localFlags = u16(localOffset + 6);
    const localNameLength = u16(localOffset + 26);
    const localExtraLength = u16(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (localFlags !== flags || u16(localOffset + 8) !== method || dataOffset + compressed > directoryOffset || localNameLength !== nameLength) throw limitError('This PowerPoint archive has inconsistent file headers.');
    for (let n = 0; n < nameLength; n++) {
      if (bytes[localOffset + 30 + n] !== nameBytes[n]) throw limitError('This PowerPoint archive has inconsistent filenames.');
    }
    if (!(flags & 8) && (u32(localOffset + 18) !== compressed || u32(localOffset + 22) !== expanded)) throw limitError('This PowerPoint archive has inconsistent file sizes.');
    entries.push({ name, method, compressed, expanded, localOffset, dataOffset });
    offset = next;
  }
  if (offset !== end || !names.has('[Content_Types].xml') || !names.has('ppt/presentation.xml')) throw limitError('This archive is not a PowerPoint presentation.');
  const slideParts = entries.filter(entry => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name));
  if (slideParts.length > MAX_SLIDES) throw limitError('PowerPoint previews support up to 500 slides.');
  const sorted = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].localOffset < sorted[i - 1].dataOffset + sorted[i - 1].compressed) throw limitError('This PowerPoint archive contains overlapping files.');
  }
  let actualTotal = 0;
  let presentationXml = '';
  let processedSinceYield = 0;
  for (const entry of entries) {
    let actual = 0;
    const chunks = [];
    const consume = data => {
      actual += data.length;
      actualTotal += data.length;
      if (actual > entry.expanded || actualTotal > MAX_EXPANDED_BYTES) throw limitError('This PowerPoint expands beyond its declared size or the 200 MB preview limit.');
      if (entry.name === 'ppt/presentation.xml') chunks.push(new Uint8Array(data));
    };
    if (entry.method === 0) consume(bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressed));
    else {
      const inflater = new Inflate(data => consume(data));
      if (!entry.compressed) inflater.push(new Uint8Array(), true);
      for (let n = 0; n < entry.compressed; n += 4096) {
        const length = Math.min(4096, entry.compressed - n);
        inflater.push(bytes.subarray(entry.dataOffset + n, entry.dataOffset + n + length), n + length === entry.compressed);
        processedSinceYield += length;
        if (processedSinceYield >= 1024 * 1024) { processedSinceYield = 0; await tick(); }
      }
    }
    if (actual !== entry.expanded) throw limitError('This PowerPoint archive is truncated or has inconsistent sizes.');
    if (entry.name === 'ppt/presentation.xml') {
      const combined = new Uint8Array(actual);
      let at = 0;
      for (const chunk of chunks) { combined.set(chunk, at); at += chunk.length; }
      presentationXml = decoder.decode(combined);
    }
  }
  const references = presentationXml.match(/<(?:[a-z_][\w.-]*:)?sldId\b/gi) || [];
  if (references.length > MAX_SLIDES) throw limitError('PowerPoint previews support up to 500 slides.');
  if (!references.length) throw limitError('This PowerPoint does not contain any slides.');
  return { declaredBytes: declaredTotal, expandedBytes: actualTotal, entries: entries.length, slideCount: references.length };
}

async function pdfLibrary() {
  if (!pdfModulePromise) pdfModulePromise = import('pdfjs-dist/legacy/build/pdf.mjs').then(pdfjs => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href;
    return pdfjs;
  });
  return pdfModulePromise;
}

async function openPdf(bytes) {
  if (!decoder.decode(bytes.subarray(0, Math.min(bytes.length, 1024))).includes('%PDF-')) throw limitError('This file does not appear to be a PDF.');
  const pdfjs = await pdfLibrary();
  const task = pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    enableXfa: false,
    stopAtErrors: true,
    maxImageSize: 16000000,
    canvasMaxAreaInBytes: 32000000,
    cMapUrl: new URL('./cmaps/', import.meta.url).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('./standard_fonts/', import.meta.url).href,
    wasmUrl: new URL('./wasm/', import.meta.url).href,
    iccUrl: new URL('./iccs/', import.meta.url).href
  });
  try {
    const document = await task.promise;
    if (document.numPages < 1 || document.numPages > MAX_SLIDES) {
      await task.destroy();
      throw limitError('PDF previews support between 1 and 500 pages.');
    }
    return { document, task, slideCount: document.numPages };
  } catch (error) {
    await task.destroy().catch(() => {});
    if (error?.name === 'PasswordException') throw limitError('Password-protected PDFs cannot be previewed. Upload an unlocked copy.');
    throw error;
  }
}

async function openPptx(bytes) {
  await validatePptxZip(bytes);
  if (!pptxModulesPromise) pptxModulesPromise = Promise.all([import('@office-kit/pptx'), import('@office-kit/pptx-preview')]);
  const [pptx, preview] = await pptxModulesPromise;
  const presentation = await pptx.loadPresentation(bytes);
  const slides = pptx.getSlides(presentation);
  if (!slides.length || slides.length > MAX_SLIDES) throw limitError('PowerPoint previews support between 1 and 500 slides.');
  return { presentation, slides, renderSlideToSvg: preview.renderSlideToSvg, slideCount: slides.length };
}

export async function inspectNative(file, format) {
  format = normalizeFormat(format);
  const bytes = await readBytes(file);
  if (format === 'pptx') {
    const result = await openPptx(bytes);
    return { slideCount: result.slideCount };
  }
  const result = await openPdf(bytes);
  const slideCount = result.slideCount;
  await result.task.destroy();
  return { slideCount };
}

const viewerCss = `
.native-preview{position:absolute;inset:0;display:flex;flex-direction:column;min-width:0;min-height:0;background:#eaece4;color:#46513b;font:13px/1.5 Arial,sans-serif;isolation:isolate}
.native-preview *{box-sizing:border-box}.native-preview [hidden]{display:none!important}
.native-preview:focus-visible{outline:3px solid #b78255;outline-offset:-3px}
.native-preview-note{flex:none;padding:9px 20px;border-bottom:1px solid #dce1d3;background:#f7f8f1;color:#7a856c;font-size:11px;text-align:center}
.native-preview-stage{min-height:0;flex:1;position:relative;display:flex;align-items:center;justify-content:center;overflow:hidden;padding:18px}
.native-preview-surface{display:block;flex:none;background:#fff;box-shadow:0 6px 30px #283c1b1a;max-width:100%;max-height:100%;object-fit:contain}
.native-preview-message{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);max-width:min(420px,85%);text-align:center;padding:16px 22px;border:1px solid #dde3d4;border-radius:9px;background:#fffef9;color:#718162;font-size:12px;box-shadow:0 8px 24px #293b1f0a}
.native-preview-message.is-error{color:#9a4b38;border-color:#e5cdbf;background:#fff8f3}
.native-preview-controls{flex:none;display:flex;align-items:center;justify-content:center;gap:14px;min-height:54px;padding:8px 16px;background:#f9faf5;border-top:1px solid #dce1d3}
.native-preview-button{appearance:none;background:#fffefb;color:#526544;border:1px solid #d0d9c5;border-radius:6px;font:600 12px/1.3 Arial,sans-serif;min-height:34px;padding:7px 12px;cursor:pointer}
.native-preview-button:hover:not(:disabled){background:#edf2e6}.native-preview-button:disabled{opacity:.4;cursor:not-allowed}
.native-preview-button:focus-visible,.native-preview-page:focus-visible{outline:3px solid #b78255;outline-offset:3px}
.native-preview-pagination{display:flex;align-items:center;gap:7px;color:#7a856c;font-size:11px;white-space:nowrap}
.native-preview-page{width:51px;min-height:32px;padding:5px 4px;border:1px solid #d4ddc9;border-radius:5px;color:#536547;background:#fff;text-align:center;font:12px Arial,sans-serif}
.native-preview.is-presenting .native-preview-note{display:none}.native-preview.is-presenting{background:#242b20}.native-preview.is-presenting .native-preview-stage{padding:10px}
.native-preview.is-presenting .native-preview-controls{background:#2d3527;border-color:#3c4733;color:#d0d8c8}.native-preview.is-presenting .native-preview-pagination{color:#c4cfb8}
.native-preview.is-presenting .native-preview-button,.native-preview.is-presenting .native-preview-page{background:#3e4b34;border-color:#536346;color:#e2eadb}
@media(max-width:600px){.native-preview-note{font-size:10px;padding:8px 12px}.native-preview-stage{padding:10px}.native-preview-controls{gap:9px;padding:8px 10px}.native-preview-button{font-size:11px;padding:7px 10px}.native-preview-pagination{gap:5px}.native-preview-page{width:44px;font-size:16px}}
`;

function safeSvgMarkup(svg) {
  if (typeof svg !== 'string' || svg.length > 20 * 1024 * 1024) throw limitError('This slide is too complex to preview in the browser.');
  // Parsed only in an inert XML document. Display still occurs exclusively through
  // an image Blob URL: uploaded markup never joins the parent document's DOM.
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (parsed.querySelector('parsererror') || parsed.documentElement.localName !== 'svg') throw limitError('This PowerPoint slide could not be rendered.');
  parsed.querySelectorAll('script,foreignObject,iframe,object,embed,style,link,animate,animateTransform,set').forEach(node => node.remove());
  for (const node of parsed.querySelectorAll('*')) {
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name.startsWith('on')) node.removeAttributeNode(attr);
      else if ((name === 'href' || name.endsWith(':href')) && !value.startsWith('#') && !/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,/i.test(value)) node.removeAttributeNode(attr);
      else if (['style', 'fill', 'stroke', 'filter', 'clip-path', 'mask'].includes(name)) {
        const urls = [...value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)];
        if (urls.some(match => !match[2].trim().startsWith('#'))) node.removeAttributeNode(attr);
      }
    }
  }
  return new XMLSerializer().serializeToString(parsed.documentElement);
}

function browserMeasurer() {
  const context = document.createElement('canvas').getContext('2d');
  return (text, spec) => {
    if (!context) return { widthPx: text.length * spec.sizePx * .55, approximate: true };
    const family = String(spec.family).replace(/["\\\n\r]/g, '');
    context.font = `${spec.italic ? 'italic ' : ''}${spec.bold ? 'bold ' : ''}${Math.max(1, spec.sizePx)}px "${family}"`;
    context.fontKerning = spec.kerning === false ? 'none' : 'normal';
    const measured = context.measureText(text);
    return {
      widthPx: measured.width + Math.max(0, [...text].length - 1) * (spec.letterSpacingPx || 0),
      ascentPx: measured.fontBoundingBoxAscent || spec.sizePx * .8,
      descentPx: measured.fontBoundingBoxDescent || spec.sizePx * .2,
      approximate: false
    };
  };
}

function browserFamily(family) {
  if (/courier|mono|consolas/i.test(family || '')) return 'Courier New';
  if (/times|cambria|caladea|georgia|serif/i.test(family || '') && !/sans/i.test(family || '')) return 'Times New Roman';
  return 'Arial';
}

export async function mountNativeViewer(host, fileOrBlob, format, { onError } = {}) {
  if (!host || typeof host.append !== 'function') throw new Error('A viewer host element is required.');
  format = normalizeFormat(format);
  let destroyed = false;
  let current = 1;
  let generation = 0;
  let animationFrame = 0;
  let renderTask;
  let documentData;
  let lastObjectUrl;
  let pendingObjectUrl;
  let lastRenderedKey = '';
  const cache = new Map();
  const root = make('div', 'native-preview');
  root.tabIndex = 0;
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', format === 'pdf' ? 'PDF presentation preview' : 'PowerPoint presentation preview');
  const styles = make('style');
  styles.textContent = viewerCss;
  const note = make('p', 'native-preview-note', format === 'pptx'
    ? 'PowerPoint preview · Animations, media, and some formatting may differ. Download the original for the full presentation.'
    : 'PDF preview · View pages here or download the original file.');
  const stage = make('div', 'native-preview-stage');
  const status = make('div', 'native-preview-message', 'Opening presentation…');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const controls = make('div', 'native-preview-controls');
  const previous = make('button', 'native-preview-button', '← Previous');
  previous.type = 'button';
  previous.setAttribute('aria-label', format === 'pdf' ? 'Previous page' : 'Previous slide');
  const next = make('button', 'native-preview-button', 'Next →');
  next.type = 'button';
  next.setAttribute('aria-label', format === 'pdf' ? 'Next page' : 'Next slide');
  const pagination = make('label', 'native-preview-pagination');
  const pageLabel = make('span', '', format === 'pdf' ? 'Page' : 'Slide');
  const pageInput = make('input', 'native-preview-page');
  Object.assign(pageInput, { type: 'number', min: '1', max: '1', step: '1', value: '1' });
  pageInput.setAttribute('aria-label', format === 'pdf' ? 'Page number' : 'Slide number');
  const pageCount = make('span', '', 'of —');
  pagination.append(pageLabel, pageInput, pageCount);
  const fullscreen = make('button', 'native-preview-button', '⛶');
  fullscreen.type = 'button';
  fullscreen.hidden = !document.fullscreenEnabled;
  const updateFullscreen = () => {
    const label = document.fullscreenElement === root ? 'Exit full screen' : 'Full screen';
    fullscreen.setAttribute('aria-label', label);
    fullscreen.title = label;
  };
  fullscreen.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement === root) await document.exitFullscreen();
      else await root.requestFullscreen();
    } catch (error) { onError?.(new Error('Full screen is unavailable in this browser. You can still present in this window.')); }
  });
  document.addEventListener('fullscreenchange', updateFullscreen);
  updateFullscreen();
  controls.append(previous, pagination, next, fullscreen);
  stage.append(status);
  root.append(styles, note, stage, controls);
  host.append(root);

  function updateControls() {
    const total = documentData?.slideCount || 0;
    previous.disabled = !total || current <= 1;
    next.disabled = !total || current >= total;
    pageInput.disabled = !total;
    pageInput.value = String(current);
    pageInput.max = String(total || 1);
    pageCount.textContent = `of ${total || '—'}`;
  }

  function showError(error) {
    if (destroyed) return;
    status.hidden = false;
    status.classList.add('is-error');
    status.textContent = error?.message || 'This presentation could not be previewed. Download the original to open it.';
    stage.setAttribute('aria-busy', 'false');
    if (typeof onError === 'function') onError(error instanceof Error ? error : new Error(status.textContent));
  }

  function fitSize(width, height) {
    const area = stage.getBoundingClientRect();
    const gutter = window.innerWidth <= 600 ? 20 : 36;
    const availableWidth = Math.max(1, area.width - gutter);
    const availableHeight = Math.max(1, area.height - gutter);
    const scale = Math.min(availableWidth / width, availableHeight / height);
    return { width: Math.max(1, width * scale), height: Math.max(1, height * scale), scale };
  }

  async function render() {
    if (destroyed || !documentData) return;
    const stageBounds = stage.getBoundingClientRect();
    const renderKey = `${current}:${Math.round(stageBounds.width)}:${Math.round(stageBounds.height)}:${Math.min(window.devicePixelRatio || 1, 2)}`;
    if (renderKey === lastRenderedKey && stage.querySelector('.native-preview-surface')) return;
    const token = ++generation;
    renderTask?.cancel();
    status.hidden = false;
    status.classList.remove('is-error');
    status.textContent = `Loading ${format === 'pdf' ? 'page' : 'slide'} ${current}…`;
    stage.setAttribute('aria-busy', 'true');
    updateControls();
    try {
      let surface;
      if (format === 'pdf') {
        const page = await documentData.document.getPage(current);
        if (destroyed || token !== generation) return;
        const original = page.getViewport({ scale: 1 });
        const fit = fitSize(original.width, original.height);
        const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(8000000 / (fit.width * fit.height)));
        const viewport = page.getViewport({ scale: fit.scale * ratio });
        surface = make('canvas', 'native-preview-surface');
        surface.width = Math.max(1, Math.floor(viewport.width));
        surface.height = Math.max(1, Math.floor(viewport.height));
        surface.style.width = `${fit.width}px`;
        surface.style.height = `${fit.height}px`;
        surface.setAttribute('role', 'img');
        surface.setAttribute('aria-label', `Page ${current} of ${documentData.slideCount}`);
        const context = surface.getContext('2d', { alpha: false });
        if (!context) throw new Error('Canvas rendering is unavailable in this browser.');
        renderTask = page.render({ canvasContext: context, viewport, background: 'rgb(255,255,255)' });
        await renderTask.promise;
      } else {
        let svg = cache.get(current);
        if (!svg) {
          await tick();
          if (destroyed || token !== generation) return;
          svg = safeSvgMarkup(documentData.renderSlideToSvg(documentData.presentation, documentData.slides[current - 1], {
            textLayout: 'svg', measureText: browserMeasurer(), resolveFamily: browserFamily
          }));
          cache.set(current, svg);
          while (cache.size > 3) cache.delete(cache.keys().next().value);
        }
        const objectUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
        pendingObjectUrl = objectUrl;
        surface = make('img', 'native-preview-surface');
        surface.alt = `Slide ${current} of ${documentData.slideCount}`;
        surface.src = objectUrl;
        await new Promise((resolve, reject) => {
          surface.onload = resolve;
          surface.onerror = () => reject(new Error('This slide preview could not be displayed. Download the original PowerPoint file.'));
          if (surface.complete && surface.naturalWidth) resolve();
        });
        if (destroyed || token !== generation) { URL.revokeObjectURL(objectUrl); return; }
        const fit = fitSize(surface.naturalWidth || 1280, surface.naturalHeight || 720);
        surface.style.width = `${fit.width}px`;
        surface.style.height = `${fit.height}px`;
        if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
        lastObjectUrl = objectUrl;
        pendingObjectUrl = null;
      }
      if (destroyed || token !== generation) return;
      stage.querySelectorAll('.native-preview-surface').forEach(node => node.remove());
      stage.prepend(surface);
      lastRenderedKey = renderKey;
      status.hidden = true;
      stage.setAttribute('aria-busy', 'false');
    } catch (error) {
      if (destroyed || token !== generation || error?.name === 'RenderingCancelledException') return;
      showError(error);
    }
  }

  function scheduleRender() {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = requestAnimationFrame(() => { animationFrame = 0; render(); });
  }

  function goTo(page) {
    const total = documentData?.slideCount || 0;
    if (!total) return;
    const value = Math.min(total, Math.max(1, Math.round(Number(page) || current)));
    if (value !== current) { current = value; scheduleRender(); }
    else updateControls();
  }
  previous.addEventListener('click', () => goTo(current - 1));
  next.addEventListener('click', () => goTo(current + 1));
  pageInput.addEventListener('change', () => goTo(pageInput.value));
  pageInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); goTo(pageInput.value); root.focus({ preventScroll: true }); }
  });
  root.addEventListener('keydown', event => {
    if (event.target instanceof HTMLInputElement || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === ' ' && event.target.closest?.('button')) return;
    if (['ArrowRight', 'PageDown', ' '].includes(event.key)) { event.preventDefault(); goTo(current + 1); }
    else if (['ArrowLeft', 'PageUp'].includes(event.key)) { event.preventDefault(); goTo(current - 1); }
    else if (event.key === 'Home') { event.preventDefault(); goTo(1); }
    else if (event.key === 'End') { event.preventDefault(); goTo(documentData?.slideCount || 1); }
  });
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleRender) : null;
  resizeObserver?.observe(stage);
  window.addEventListener('resize', scheduleRender);
  updateControls();
  try {
    const bytes = await readBytes(fileOrBlob);
    documentData = format === 'pdf' ? await openPdf(bytes) : await openPptx(bytes);
    updateControls();
    await render();
  } catch (error) { showError(error); }

  return {
    slideCount: documentData?.slideCount || 0,
    setPresenting(presenting) { root.classList.toggle('is-presenting', Boolean(presenting)); scheduleRender(); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation++;
      if (animationFrame) cancelAnimationFrame(animationFrame);
      renderTask?.cancel();
      resizeObserver?.disconnect();
      window.removeEventListener('resize', scheduleRender);
      document.removeEventListener('fullscreenchange', updateFullscreen);
      if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
      if (pendingObjectUrl && pendingObjectUrl !== lastObjectUrl) URL.revokeObjectURL(pendingObjectUrl);
      cache.clear();
      documentData?.task?.destroy().catch(() => {});
      root.remove();
    }
  };
}
