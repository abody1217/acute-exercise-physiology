const MAX_HTML_BYTES = 40 * 1024 * 1024;
const FORMAT = 'acute-exercise-editor';
const DECK_SELECTOR = 'deck-stage,x-import[component-from-global-scope="deck-stage"]';
const EDITOR_SELECTOR = '#presentation-editor-js,#presentation-editor-css,#pe-seed,#pe-bootstrap,#pe-studio-context,[data-pe-studio-context]';
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
let editorRuntime = null;

const plain = value => value && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const validId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
const encodeJson = value => JSON.stringify(value).replace(/</g, '\\u003c');
const serialize = doc => '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;

/** Supply the trusted, current editor assets once after loading the runtime pack. */
export function setEditorRuntime(runtime) {
  if (!plain(runtime) || ['css', 'core', 'ui', 'files'].some(key => typeof runtime[key] !== 'string' || !runtime[key].trim())) {
    throw new Error('The presentation editor assets are incomplete. Reload Studio and try again.');
  }
  editorRuntime = Object.freeze(Object.fromEntries(['css', 'core', 'ui', 'files'].map(key => [key, runtime[key]])));
}

function checkHtml(html) {
  if (typeof html !== 'string' || !html.trim()) throw new Error('Choose a non-empty HTML presentation.');
  if (html.length > MAX_HTML_BYTES || new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) {
    throw new Error('The HTML presentation must be 40 MB or smaller.');
  }
  if (typeof DOMParser === 'undefined') throw new Error('HTML presentation import requires a browser.');
}

function readSeed(doc) {
  const seeds = doc.querySelectorAll('script#pe-seed');
  if (!seeds.length) return null;
  if (seeds.length !== 1 || seeds[0].type !== 'application/json') throw new Error('The presentation has an invalid saved-changes section.');
  let seed;
  try { seed = JSON.parse(seeds[0].textContent); } catch (_) { throw new Error('The presentation’s saved changes are not valid JSON.'); }
  if (!plain(seed) || seed.format !== FORMAT || seed.version !== 1 || !validId(seed.deckId) ||
      !validId(seed.documentId) || !plain(seed.patches)) {
    throw new Error('The presentation’s saved changes use an unsupported format.');
  }
  validatePatchMap(seed.patches);
  return seed;
}

function validatePatchMap(patches) {
  if (!plain(patches)) throw new Error('Presentation changes must be an object.');
  for (const [id, patch] of Object.entries(patches)) {
    if (!validId(id) || RESERVED.has(id) || !plain(patch) || Object.keys(patch).some(key => RESERVED.has(key))) {
      throw new Error('The presentation contains an invalid saved edit.');
    }
  }
}

function removeOldEditor(doc) {
  doc.querySelectorAll(EDITOR_SELECTOR).forEach(node => node.remove());
  // Older frame builders did not mark their context-only bootstrap script.
  // Never retain that parent/channel binding in a standalone backup.
  for (const script of doc.querySelectorAll('script:not([src])')) {
    if (/\b(?:window\s*\.\s*)?__peStudioContext\s*=/.test(script.textContent)) script.remove();
  }
  doc.querySelectorAll('[data-presentation-editor-ui],.pe-root').forEach(node => node.remove());
  doc.body.removeAttribute('data-pe-editing');
  doc.body.removeAttribute('data-pe-preview');
  doc.body.removeAttribute('data-pe-ready');
  doc.querySelectorAll('[data-pe-selected],[data-pe-hover]').forEach(node => {
    node.removeAttribute('data-pe-selected');
    node.removeAttribute('data-pe-hover');
  });
}

function parsePresentation(html) {
  checkHtml(html);
  const parser = new DOMParser();
  // Parsed documents stay detached. Uploaded scripts are never evaluated here.
  const outer = parser.parseFromString(html, 'text/html');
  const manifests = outer.querySelectorAll('script[type="__bundler/manifest"]');
  const templates = outer.querySelectorAll('script[type="__bundler/template"]');
  const bundled = Boolean(manifests.length || templates.length);
  let content = outer;
  let templateNode = null;
  if (bundled) {
    if (manifests.length !== 1 || templates.length !== 1) throw new Error('The HTML bundle is incomplete or contains multiple presentations.');
    let manifest;
    let template;
    try {
      manifest = JSON.parse(manifests[0].textContent);
      template = JSON.parse(templates[0].textContent);
    } catch (_) { throw new Error('The HTML bundle contains damaged asset or template data.'); }
    if (!plain(manifest) || typeof template !== 'string') throw new Error('The HTML bundle has an unsupported format.');
    for (const asset of Object.values(manifest)) {
      if (!plain(asset) || typeof asset.mime !== 'string' || typeof asset.data !== 'string' ||
          (asset.compressed !== undefined && typeof asset.compressed !== 'boolean')) {
        throw new Error('The HTML bundle contains an invalid embedded asset.');
      }
    }
    content = parser.parseFromString(template, 'text/html');
    templateNode = templates[0];
  }
  const outerSeed = readSeed(outer);
  const seed = outerSeed || (content !== outer ? readSeed(content) : null);
  removeOldEditor(outer);
  if (content !== outer) removeOldEditor(content);
  const decks = content.querySelectorAll(DECK_SELECTOR);
  if (decks.length !== 1) {
    throw new Error('Choose an HTML presentation with one deck-stage slide deck. Ordinary webpages are not supported.');
  }
  const deck = decks[0];
  const slides = Array.from(deck.children).filter(node => node.tagName === 'SECTION');
  if (slides.length < 1 || slides.length > 500) throw new Error('The presentation must contain between 1 and 500 slides.');
  if (Array.from(deck.children).some(node => !['SECTION', 'STYLE', 'SCRIPT', 'TEMPLATE'].includes(node.tagName))) {
    throw new Error('Each slide must be a section directly inside the deck-stage element.');
  }
  // Replacing all IDs is deterministic, including re-importing an editor export.
  slides.forEach((slide, index) => {
    [slide, ...slide.querySelectorAll('*')].forEach((element, position) => {
      element.setAttribute('data-pe-id', 's' + String(index + 1).padStart(2, '0') + '-e' + String(position).padStart(4, '0'));
    });
  });
  return {outer, content, bundled, templateNode, seed, slideCount: slides.length};
}

/** Inspect supported HTML without executing or mounting any uploaded content. */
export function inspectHtml(html) {
  const parsed = parsePresentation(html);
  return {slideCount: parsed.slideCount, patches: parsed.seed ? parsed.seed.patches : {},
    deckId: parsed.seed ? parsed.seed.deckId : null, documentId: parsed.seed ? parsed.seed.documentId : null};
}

function trustedContext(context, deckId, documentId, patches) {
  if (context === null) return null;
  let origin;
  try { origin = new URL(context.parentOrigin); } catch (_) { throw new Error('The Studio parent origin is invalid.'); }
  if (!plain(context) || !validId(context.channel) || context.channel.length < 16 ||
      !['http:', 'https:'].includes(origin.protocol) || origin.origin !== context.parentOrigin ||
      !['edit', 'present'].includes(context.mode) || context.deckId !== deckId || context.documentId !== documentId) {
    throw new Error('The Studio frame connection settings are invalid.');
  }
  // Copy only these fields: credentials and unrelated host state never enter the frame.
  return {channel: context.channel, parentOrigin: context.parentOrigin, deckId, documentId,
    mode: context.mode, patches};
}

function appendScript(doc, id, code) {
  const script = doc.createElement('script');
  script.id = id;
  script.textContent = code.replace(/<\/script/gi, '<\\/script');
  doc.head.append(script);
  return script;
}

/** Return a sandbox-frame document or a standalone editable HTML backup. */
export function buildHtml(html, {context = null, patches = {}, documentId, deckId: requestedDeckId} = {}) {
  if (!editorRuntime) throw new Error('The presentation editor is still loading. Try again in a moment.');
  const parsed = parsePresentation(html);
  validatePatchMap(patches);
  const deckId = context ? context.deckId : requestedDeckId || (parsed.seed && parsed.seed.deckId);
  const id = documentId || (context && context.documentId) || (parsed.seed && parsed.seed.documentId);
  if (!validId(deckId) || !validId(id)) throw new Error('A presentation identifier and document identifier are required.');
  const studio = trustedContext(context, deckId, id, patches);
  const state = {format: FORMAT, version: 1, deckId, documentId: id, patches};
  const {outer, content} = parsed;

  const style = content.createElement('style');
  style.id = 'presentation-editor-css';
  style.textContent = editorRuntime.css;
  content.head.append(style);
  const code = [editorRuntime.ui, editorRuntime.files, editorRuntime.core].join('\n;\n');
  appendScript(content, 'presentation-editor-js',
    '(function(){const startEditor=function(){\n' + code + '\n};' +
    'if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",startEditor,{once:true});else startEditor();})();');

  if (parsed.bundled) parsed.templateNode.textContent = encodeJson(serialize(content));
  const seed = outer.createElement('script');
  seed.id = 'pe-seed';
  seed.type = 'application/json';
  seed.textContent = encodeJson(state);
  const bootstrap = outer.createElement('script');
  bootstrap.id = 'pe-bootstrap';
  bootstrap.textContent = 'window.__peSeed=JSON.parse(document.getElementById("pe-seed").textContent);' +
    'document.addEventListener("DOMContentLoaded",function(){' +
    'window.__peBundleHtml="<!DOCTYPE html>\\n"+document.documentElement.outerHTML;' +
    'window.__peSeed=JSON.parse(document.getElementById("pe-seed").textContent);' +
    '},{once:true});';
  // Register capture before the original bundle loader. The source seed is
  // available synchronously, including plain-HTML parser-time deck mounts.
  outer.head.prepend(seed, bootstrap);
  if (studio) {
    const contextScript = outer.createElement('script');
    contextScript.id = 'pe-studio-context';
    contextScript.textContent = 'window.__peStudioContext=' + encodeJson(studio) + ';';
    outer.head.prepend(contextScript);
  }
  const result = serialize(outer);
  if (new TextEncoder().encode(result).byteLength > MAX_HTML_BYTES) throw new Error('The edited HTML presentation exceeds the 40 MB limit. Use smaller images.');
  return result;
}
