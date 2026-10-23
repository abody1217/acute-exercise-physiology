(function () {
  'use strict';

  const EFFECTS = new Set(['original', 'none', 'fade', 'up', 'down', 'left', 'right', 'zoom', 'pop']);
  const DURATIONS = {up: 800, fade: 1000, pop: 700, draw: 1800, growx: 1100, growy: 1100, flow: 1400, beat: 1800, float: 6000, dot: 3000};
  const FORMAT = 'acute-exercise-editor';
  const DECK = 'acute-exercise-v1';
  const MAX_DOWNLOAD = 25 * 1024 * 1024;
  const motionProperties = ['animation-duration', 'animation-delay', '--pe-animation', '--pe-duration', '--pe-delay'];
  const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  const shorten = value => String(value).replace(/\s+/g, ' ').trim().slice(0, 72);
  const milliseconds = (value, fallback) => value ? parseFloat(value) * (value.endsWith('ms') ? 1 : 1000) : fallback;

  function start(deck) {
    const files = window.PresentationEditorFiles;
    const slides = Array.from(deck.children).filter(el => el.tagName === 'SECTION');
    const records = new Map();
    const slideItems = slides.map(() => []);
    const textRecords = new WeakMap();
    const imageRecords = new WeakMap();
    const motionRecords = new WeakMap();
    let patches = {};
    let rendered = {};
    let selectedId = null;
    let open = false;
    let ui;
    let status = 'Published presentation. Edits are saved as a browser draft.';
    let statusKind = 'normal';
    let undo = [];
    let redo = [];
    let saveTimer;
    let saveVersion = 0;
    let previewTimer;
    let availableDraft = null;
    let draftChecked = false;
    let draftApplied = false;
    let hasEdited = false;
    let mutationEpoch = 0;
    let pendingOperation = 0;
    let seed;

    function motionFor(element, slideIndex) {
      const target = element.closest('[data-a]') || element;
      let record = motionRecords.get(target);
      if (record) return record;
      const id = target.dataset.peId + '-m';
      const original = target.getAttribute('data-a');
      const duration = milliseconds(target.style.animationDuration, DURATIONS[original] || 800);
      const delay = milliseconds(target.style.animationDelay, 0);
      record = {id, type: 'motion', element: target, slideIndex, original,
        baseline: {effect: 'original', duration, delay},
        style: motionProperties.map(name => [name, target.style.getPropertyValue(name), target.style.getPropertyPriority(name)])};
      records.set(id, record);
      motionRecords.set(target, record);
      return record;
    }

    slides.forEach((slide, slideIndex) => {
      slide.querySelectorAll('[data-pe-id]').forEach(element => {
        if (element.closest('script,style,defs')) return;
        if (element.tagName === 'IMG') {
          const record = {id: element.dataset.peId + '-i', type: 'image', element, slideIndex,
            baseline: {src: element.getAttribute('src'), alt: element.getAttribute('alt') || ''}};
          record.motion = motionFor(element, slideIndex);
          records.set(record.id, record);
          imageRecords.set(element, record);
          slideItems[slideIndex].push(record);
        }
        Array.from(element.childNodes).forEach((node, index) => {
          if (node.nodeType !== Node.TEXT_NODE || !node.nodeValue.trim()) return;
          const record = {id: element.dataset.peId + '-t' + index, type: 'text', element, node, slideIndex, baseline: node.nodeValue};
          record.motion = motionFor(element, slideIndex);
          records.set(record.id, record);
          textRecords.set(node, record);
          slideItems[slideIndex].push(record);
        });
      });
      slide.querySelectorAll('[data-a]').forEach(element => {
        const record = motionFor(element, slideIndex);
        slideItems[slideIndex].push(record);
      });
    });

    function validateState(value) {
      if (!plain(value) || value.format !== FORMAT || value.version !== 1 || value.deckId !== DECK ||
          typeof value.documentId !== 'string' || !value.documentId || value.documentId.length > 200 || !plain(value.patches)) {
        throw new Error('This changes file belongs to a different presentation or editor version.');
      }
      if (Object.keys(value.patches).length > records.size) throw new Error('The changes file contains too many edits.');
      const clean = {};
      let totalSize = 0;
      for (const [id, patch] of Object.entries(value.patches)) {
        const record = records.get(id);
        if (!record || !plain(patch)) throw new Error('The changes file contains an unknown slide item.');
        if (record.type === 'text') {
          if (Object.keys(patch).some(key => key !== 'text') || typeof patch.text !== 'string' || patch.text.length > 10000) throw new Error('A text edit is invalid or too long (maximum 10,000 characters).');
          clean[id] = {text: patch.text};
          totalSize += patch.text.length;
        } else if (record.type === 'image') {
          if (Object.keys(patch).some(key => !['src', 'alt'].includes(key)) || typeof patch.alt !== 'string' || patch.alt.length > 2000 ||
              (patch.src !== undefined && (typeof patch.src !== 'string' || patch.src.length > 14 * 1024 * 1024 || !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(patch.src)))) {
            throw new Error('An image edit is invalid. Use a PNG, JPEG, WebP, or GIF image up to 10 MB.');
          }
          clean[id] = patch.src === undefined ? {alt: patch.alt} : {src: patch.src, alt: patch.alt};
          totalSize += (patch.src || '').length + patch.alt.length;
        } else {
          if (Object.keys(patch).some(key => !['effect', 'duration', 'delay'].includes(key)) || !EFFECTS.has(patch.effect) ||
              !Number.isFinite(patch.duration) || patch.duration < 100 || patch.duration > 10000 ||
              !Number.isFinite(patch.delay) || patch.delay < 0 || patch.delay > 10000) throw new Error('An animation setting is invalid.');
          clean[id] = {effect: patch.effect, duration: patch.duration, delay: patch.delay};
        }
        if (totalSize > 19 * 1024 * 1024) throw new Error('These changes are too large to publish through GitHub. Use smaller replacement images.');
      }
      return {format: FORMAT, version: 1, deckId: DECK, documentId: value.documentId, patches: clean};
    }

    function currentState(documentId) {
      return {format: FORMAT, version: 1, deckId: DECK, documentId: documentId || seed.documentId, patches: {...patches}};
    }

    function applyAll() {
      const changed = new Set([...Object.keys(rendered), ...Object.keys(patches)]);
      changed.forEach(id => {
        if (rendered[id] === patches[id]) return;
        const record = records.get(id);
        const patch = patches[id];
        if (record.type === 'text') record.node.nodeValue = patch ? patch.text : record.baseline;
        else if (record.type === 'image') {
          const src = patch && patch.src || record.baseline.src;
          if (record.element.getAttribute('src') !== src) record.element.setAttribute('src', src);
          record.element.setAttribute('alt', patch ? patch.alt : record.baseline.alt);
        } else {
          const element = record.element;
          element.removeAttribute('data-pe-effect');
          record.style.forEach(([name, value, priority]) => {
            if (value) element.style.setProperty(name, value, priority);
            else element.style.removeProperty(name);
          });
          if (patch) {
            if (patch.effect === 'original') {
              element.style.setProperty('animation-duration', patch.duration + 'ms', 'important');
              element.style.setProperty('animation-delay', patch.delay + 'ms', 'important');
            } else {
              element.dataset.peEffect = patch.effect;
              element.style.setProperty('--pe-animation', 'pe-' + patch.effect);
              element.style.setProperty('--pe-duration', patch.duration + 'ms');
              element.style.setProperty('--pe-delay', patch.delay + 'ms');
            }
          }
        }
      });
      rendered = {...patches};
    }

    function label(record) {
      if (record.type === 'text') return 'Text · ' + (shorten(record.node.nodeValue) || '(empty)');
      if (record.type === 'image') return 'Image · ' + (shorten(record.element.getAttribute('alt')) || 'Slide image');
      const text = shorten(record.element.textContent);
      return 'Motion · ' + (text || record.element.tagName.toLowerCase() + ' — ' + (record.original || 'none'));
    }

    function render() {
      const record = records.get(selectedId);
      const motion = record && (record.type === 'motion' ? record : record.motion);
      ui.render({slideLabel: 'Slide ' + (deck.index + 1) + ' of ' + slides.length,
        items: slideItems[deck.index].map(item => ({id: item.id, type: item.type, label: label(item)})),
        selected: record ? {id: record.id, type: record.type, label: label(record),
          text: record.type === 'text' ? record.node.nodeValue : undefined,
          alt: record.type === 'image' ? record.element.getAttribute('alt') || '' : undefined,
          motion: patches[motion.id] || motion.baseline,
          motionLabel: motion.element === record.element ? 'Applies to this item' : 'Applies to the containing animation group'} : null,
        status, statusKind, canUndo: undo.length > 0, canRedo: redo.length > 0, dirty: Object.keys(patches).length > 0});
    }

    function message(text, error) {
      status = text;
      statusKind = error ? 'error' : 'normal';
      if (ui) render();
    }

    function select(id) {
      deck.querySelectorAll('[data-pe-selected]').forEach(el => el.removeAttribute('data-pe-selected'));
      const record = records.get(id);
      selectedId = record && record.slideIndex === deck.index ? id : null;
      if (selectedId && open) record.element.setAttribute('data-pe-selected', '');
      render();
    }

    function saveSoon() {
      clearTimeout(saveTimer);
      const version = ++saveVersion;
      message('Saving draft on this browser…');
      const state = currentState();
      saveTimer = setTimeout(async () => {
        try {
          await files.saveDraft(seed.documentId, state);
          if (version === saveVersion) message('Draft saved on this browser. Download to publish.');
        } catch (error) {
          if (version === saveVersion) message(error.message, true);
        }
      }, 300);
    }

    function commit(next) {
      mutationEpoch++;
      const clean = validateState({...currentState(), patches: next}).patches;
      if (JSON.stringify(clean) === JSON.stringify(patches)) return;
      undo.push(patches);
      if (undo.length > 60) undo.shift();
      redo = [];
      patches = clean;
      hasEdited = true;
      stopPreview();
      applyAll();
      render();
      saveSoon();
    }

    function changeOne(id, patch) {
      commit({...patches, [id]: patch});
    }

    function history(backward) {
      mutationEpoch++;
      const from = backward ? undo : redo;
      const to = backward ? redo : undo;
      if (!from.length) return;
      to.push(patches);
      patches = from.pop();
      hasEdited = true;
      stopPreview();
      applyAll();
      render();
      saveSoon();
    }

    function stopPreview() {
      clearTimeout(previewTimer);
      document.body.removeAttribute('data-pe-preview');
    }

    function replay() {
      stopPreview();
      const slide = slides[deck.index];
      slide.removeAttribute('data-deck-active');
      void slide.offsetWidth;
      document.body.setAttribute('data-pe-preview', '');
      slide.setAttribute('data-deck-active', '');
      const item = records.get(selectedId);
      const motion = item && (item.type === 'motion' ? item : item.motion);
      const settings = motion && (patches[motion.id] || motion.baseline);
      previewTimer = setTimeout(stopPreview, Math.max(4000, settings ? settings.duration + settings.delay + 1000 : 6000));
    }

    // Reserve room for the editor without changing any authored slide geometry.
    const originalFit = deck._fit.bind(deck);
    deck._fit = function () {
      originalFit();
      const stage = deck.shadowRoot.querySelector('.stage');
      const canvas = deck.shadowRoot.querySelector('.canvas');
      const overlay = deck.shadowRoot.querySelector('.overlay');
      if (!stage || !canvas) return;
      const mobile = window.innerWidth < 900;
      const right = open && !mobile ? ui.panel.getBoundingClientRect().width : 0;
      const bottom = open && mobile ? ui.panel.getBoundingClientRect().height : 0;
      stage.style.right = right + 'px';
      stage.style.bottom = bottom + 'px';
      if (overlay) {
        overlay.style.marginLeft = (deck._railWidth() - right) / 2 + 'px';
        overlay.style.bottom = bottom ? bottom + 8 + 'px' : '';
      }
      if (open) {
        canvas.style.transform = 'scale(' + Math.min((window.innerWidth - deck._railWidth() - right) / deck.designWidth,
          (window.innerHeight - bottom) / deck.designHeight) + ')';
      }
    };

    function resumeDraft() {
      if (draftApplied || !draftChecked || !open) return;
      draftApplied = true;
      if (availableDraft && !hasEdited) {
        patches = availableDraft.patches;
        applyAll();
        message('Restored your browser draft. Download to publish.');
      }
    }

    function toggle(value) {
      open = value;
      document.body.toggleAttribute('data-pe-editing', open);
      stopPreview();
      resumeDraft();
      if (!open) {
        deck.querySelectorAll('[data-pe-selected],[data-pe-hover]').forEach(el => {
          el.removeAttribute('data-pe-selected'); el.removeAttribute('data-pe-hover');
        });
      } else if (selectedId) select(selectedId);
      deck._fit();
      if (!open) {
        const slide = slides[deck.index];
        slide.removeAttribute('data-deck-active');
        void slide.offsetWidth;
        slide.setAttribute('data-deck-active', '');
      }
    }

    const safeAction = action => async (...args) => {
      try { return await action(...args); }
      catch (error) { message(error.message || 'The change could not be applied.', true); }
    };

    ui = new window.PresentationEditorUI({
      onToggle: toggle, onSelect: select, onUndo: () => history(true), onRedo: () => history(false),
      onApplyText: safeAction(text => {
        const record = records.get(selectedId);
        if (record && record.type === 'text') changeOne(record.id, {text});
      }),
      onReplaceImage: safeAction(async (file, alt) => {
        const record = records.get(selectedId);
        if (!record || record.type !== 'image') return;
        const epoch = mutationEpoch;
        const operation = ++pendingOperation;
        const src = file ? (await files.readImage(file)).dataURL : (patches[record.id] || {}).src;
        if (epoch !== mutationEpoch || operation !== pendingOperation) { message('Image replacement cancelled because the draft changed. Please apply it again.'); return; }
        changeOne(record.id, src === undefined ? {alt} : {src, alt});
      }),
      onApplyMotion: safeAction(settings => {
        const record = records.get(selectedId);
        if (record) changeOne((record.type === 'motion' ? record : record.motion).id, settings);
      }),
      onPreview: replay,
      onDownload: safeAction(() => {
        const id = 'acute-exercise-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));
        const blob = files.buildExport(window.__peBundleHtml, currentState(id));
        if (blob.size > MAX_DOWNLOAD) throw new Error('This file is larger than GitHub’s 25 MB upload limit. Use smaller replacement images.');
        files.download(blob, 'index.html');
        message('Download ready. Upload index.html to GitHub to update the shared link.');
      }),
      onExport: safeAction(() => {
        files.download(new Blob([JSON.stringify(currentState(), null, 2)], {type: 'application/json'}), 'presentation-changes.json');
        message('Changes exported as a backup.');
      }),
      onImport: safeAction(async file => {
        const epoch = mutationEpoch;
        const operation = ++pendingOperation;
        const imported = validateState(await files.readChanges(file));
        // Decode every imported raster before applying any edits, so broken or
        // disguised image data cannot replace a working picture.
        for (const patch of Object.values(imported.patches)) {
          if (!patch.src) continue;
          const blob = await (await fetch(patch.src)).blob();
          await files.readImage(blob);
        }
        if (epoch !== mutationEpoch || operation !== pendingOperation) { message('Import cancelled because the draft changed. Please import again.'); return; }
        commit(imported.patches);
      }),
      onReset: () => commit({...seed.patches})
    });
    ui.root.addEventListener('keydown', event => event.stopPropagation());
    ui.textInput.maxLength = 10000;
    ui.altInput.maxLength = 2000;

    function clickedRecord(event) {
      const target = event.target instanceof Element ? event.target : event.target.parentElement;
      const slide = target.closest('section[data-deck-active]');
      if (!slide || slide.parentElement !== deck) return null;
      const img = target.closest('img');
      if (img && imageRecords.has(img)) return imageRecords.get(img);
      const caret = document.caretPositionFromPoint ? document.caretPositionFromPoint(event.clientX, event.clientY) :
        document.caretRangeFromPoint ? document.caretRangeFromPoint(event.clientX, event.clientY) : null;
      const node = caret && (caret.offsetNode || caret.startContainer);
      if (node && target.contains(node) && textRecords.has(node)) return textRecords.get(node);
      for (let element = target; element && element !== slide; element = element.parentElement) {
        for (const node of element.childNodes) if (textRecords.has(node)) return textRecords.get(node);
        if (motionRecords.has(element)) return motionRecords.get(element);
      }
      return null;
    }

    deck.addEventListener('click', event => {
      if (!open || !(event.target instanceof Element) || !event.target.closest('section[data-deck-active]')) return;
      event.preventDefault();
      event.stopPropagation();
      const record = clickedRecord(event);
      if (record) select(record.id);
    }, true);
    deck.addEventListener('pointermove', event => {
      if (!open) return;
      const record = clickedRecord(event);
      const previous = deck.querySelector('[data-pe-hover]');
      if (previous && (!record || previous !== record.element)) previous.removeAttribute('data-pe-hover');
      if (record && previous !== record.element) record.element.setAttribute('data-pe-hover', '');
    });
    deck.addEventListener('pointerleave', () => {
      deck.querySelectorAll('[data-pe-hover]').forEach(el => el.removeAttribute('data-pe-hover'));
    });
    deck.addEventListener('slidechange', () => {
      stopPreview();
      select(null);
    });
    // The exported viewer's slide-reordering menu depends on its authoring host.
    // Leave navigation enabled, but don't offer unsupported structural edits.
    deck.addEventListener('keydown', event => {
      if (['Delete', 'Backspace'].includes(event.key) && event.composedPath().some(el => el.classList && el.classList.contains('rail'))) {
        event.preventDefault(); event.stopPropagation();
      }
    }, true);
    ['contextmenu', 'dragstart'].forEach(name => deck.addEventListener(name, event => {
      if (event.composedPath().some(el => el.classList && el.classList.contains('rail'))) {
        event.preventDefault(); event.stopPropagation();
      }
    }, true));

    try {
      seed = validateState(window.__peSeed);
    } catch (error) {
      seed = {format: FORMAT, version: 1, deckId: DECK, documentId: 'acute-exercise-main-v1', patches: {}};
      message('Saved edits could not be loaded: ' + error.message, true);
    }
    patches = seed.patches;
    applyAll();
    render();
    files.loadDraft(seed.documentId).then(value => {
      if (value) availableDraft = validateState(value);
      draftChecked = true;
      resumeDraft();
    }).catch(error => { draftChecked = true; message(error.message, true); });
    document.body.setAttribute('data-pe-ready', '');
    if (new URLSearchParams(location.search).get('edit') === '1') { ui.setOpen(true); toggle(true); }
  }

  let attempts = 0;
  function ready() {
    const deck = document.querySelector('deck-stage');
    if (deck && typeof deck._fit === 'function' && deck.length === 43 && deck.shadowRoot && deck.shadowRoot.querySelector('.canvas')) {
      start(deck);
    } else if (++attempts < 200) setTimeout(ready, 50);
    else console.error('The presentation editor could not initialize. Reload the page to try again.');
  }
  ready();
})();
