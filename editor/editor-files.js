(function () {
  'use strict';

  const DB_NAME = 'presentation-editor';
  const STORE_NAME = 'drafts';
  const STORAGE_PREFIX = 'presentation-editor:';
  const IMAGE_LIMIT = 10 * 1024 * 1024;
  const CHANGES_LIMIT = 40 * 1024 * 1024;
  const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
  let lastSavedAt = 0;
  const pendingSaves = new Map();

  function plainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function validateState(state) {
    if (!plainObject(state) || state.format !== 'acute-exercise-editor' ||
        state.version !== 1 || state.deckId !== 'acute-exercise-v1' ||
        typeof state.documentId !== 'string' || !state.documentId.trim() ||
        state.documentId.length > 200 || !plainObject(state.patches)) {
      throw new Error('This is not a compatible presentation changes file.');
    }
    for (const key of Object.keys(state)) {
      if (FORBIDDEN_KEYS.has(key)) throw new Error('The changes file contains an invalid property.');
    }
    for (const key of Object.keys(state.patches)) {
      if (!key || key.length > 200 || FORBIDDEN_KEYS.has(key) || !plainObject(state.patches[key])) {
        throw new Error('The changes file contains an invalid edit.');
      }
    }
    return state;
  }

  function validateKey(key) {
    if (typeof key !== 'string' || !key || key.length > 500) {
      throw new Error('A valid draft identifier is required.');
    }
  }

  function storageError(action, errors) {
    const isQuota = errors.some((error) => error &&
      (error.name === 'QuotaExceededError' || /quota|space|storage.*full/i.test(error.message || '')));
    return new Error(isQuota
      ? 'The browser has no space to save this draft. Download your presentation or changes to keep them.'
      : 'The browser could not ' + action + ' this draft. Browser storage may be disabled. Download your changes to keep them.',
    { cause: errors[errors.length - 1] });
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      let request;
      let settled = false;
      let timer;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error || new Error('Browser database is unavailable.'));
      };
      try {
        if (!window.indexedDB) throw new Error('Browser database is unavailable.');
        request = window.indexedDB.open(DB_NAME, 1);
        timer = setTimeout(() => fail(new Error('Browser database did not respond.')), 5000);
        request.onupgradeneeded = () => {
          try {
            if (!request.result.objectStoreNames.contains(STORE_NAME)) {
              request.result.createObjectStore(STORE_NAME);
            }
          } catch (error) {
            try { request.transaction.abort(); } catch (_) { /* Already aborted. */ }
            fail(error);
          }
        };
        request.onblocked = () => fail(new Error('Browser database is blocked by another tab.'));
        request.onerror = () => fail(request.error);
        request.onsuccess = () => {
          const database = request.result;
          if (settled) {
            database.close();
            return;
          }
          settled = true;
          clearTimeout(timer);
          database.onversionchange = () => database.close();
          resolve(database);
        };
      } catch (error) {
        fail(error);
      }
    });
  }

  async function databaseOperation(key, state, write) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      let transaction;
      let result;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        database.close();
        reject(error || new Error('Browser storage transaction failed.'));
      };
      try {
        transaction = database.transaction(STORE_NAME, write ? 'readwrite' : 'readonly');
        transaction.oncomplete = () => {
          if (settled) return;
          settled = true;
          database.close();
          resolve(write ? 'browser' : result);
        };
        transaction.onabort = () => fail(transaction.error);
        transaction.onerror = () => fail(transaction.error);
        const store = transaction.objectStore(STORE_NAME);
        const request = write ? store.put(state, key) : store.get(key);
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => fail(request.error);
      } catch (error) {
        fail(error);
      }
    });
  }

  function savedEntry(value) {
    if (value === undefined || value === null) return null;
    if (plainObject(value) && value.__presentationDraft === 1) {
      if (!Number.isFinite(value.savedAt) || value.savedAt < 0) throw new Error('Invalid saved draft timestamp.');
      return { savedAt: value.savedAt, state: validateState(value.state) };
    }
    // Accept drafts saved before the timestamp envelope was introduced.
    return { savedAt: 0, state: validateState(value) };
  }

  async function loadDraft(key) {
    validateKey(key);
    let databaseError;
    let value;
    try {
      value = await databaseOperation(key, null, false);
    } catch (error) {
      databaseError = error;
    }
    let serialized;
    let localError;
    try {
      serialized = window.localStorage.getItem(STORAGE_PREFIX + key);
    } catch (error) {
      localError = error;
      if (databaseError) throw storageError('load', [databaseError, error]);
    }
    try {
      const databaseEntry = savedEntry(value);
      const localEntry = localError || serialized === null ? null : savedEntry(JSON.parse(serialized));
      // A fallback save can be newer than an older database draft whose
      // replacement failed, so select by committed timestamp across stores.
      const latest = localEntry && (!databaseEntry || localEntry.savedAt > databaseEntry.savedAt)
        ? localEntry : databaseEntry;
      return latest ? latest.state : null;
    } catch (error) {
      throw new Error('The saved draft could not be read. Import a downloaded changes file to recover your edits.', { cause: error });
    }
  }

  async function saveDraft(key, state) {
    validateKey(key);
    validateState(state);
    // Snapshot before an asynchronous transaction so later edits cannot alter
    // the draft while it is waiting for the database to open.
    let serialized;
    let snapshot;
    try {
      lastSavedAt = Math.max(Date.now(), lastSavedAt + 1);
      serialized = JSON.stringify({ __presentationDraft: 1, savedAt: lastSavedAt, state });
      snapshot = JSON.parse(serialized);
    } catch (error) {
      throw new Error('The draft could not be prepared for saving.', { cause: error });
    }
    const previous = pendingSaves.get(key) || Promise.resolve();
    // Keep fast consecutive autosaves in call order. An earlier failure is
    // already reported to its caller and must not prevent later recovery.
    const operation = previous.catch(() => {}).then(async () => {
      try {
        await databaseOperation(key, snapshot, true);
        try {
          const existing = window.localStorage.getItem(STORAGE_PREFIX + key);
          const entry = existing ? savedEntry(JSON.parse(existing)) : null;
          if (!entry || entry.savedAt <= snapshot.savedAt) window.localStorage.removeItem(STORAGE_PREFIX + key);
        } catch (_) { /* Database save already committed; fallback cleanup is optional. */ }
        return 'browser';
      } catch (databaseError) {
        try {
          window.localStorage.setItem(STORAGE_PREFIX + key, serialized);
          // A successful write is the fallback persistence acknowledgement.
          return 'browser';
        } catch (error) {
          throw storageError('save', [databaseError, error]);
        }
      }
    });
    pendingSaves.set(key, operation);
    try {
      return await operation;
    } finally {
      if (pendingSaves.get(key) === operation) pendingSaves.delete(key);
    }
  }

  function checkFile(file, limit, label) {
    if (!file || typeof file.size !== 'number' || !Number.isFinite(file.size) ||
        file.size < 1 || typeof file.arrayBuffer !== 'function') {
      throw new Error('Choose a valid ' + label + ' file.');
    }
    if (file.size > limit) {
      throw new Error('The ' + label + ' file must be ' + (limit / 1024 / 1024) + ' MB or smaller.');
    }
  }

  function imageMime(bytes) {
    const starts = (...signature) => signature.every((value, index) => bytes[index] === value);
    if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
    if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
    if (starts(0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || starts(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)) return 'image/gif';
    if (bytes.length >= 16 && starts(0x52, 0x49, 0x46, 0x46) &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 &&
        bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 &&
        (bytes[15] === 0x20 || bytes[15] === 0x4c || bytes[15] === 0x58)) return 'image/webp';
    return null;
  }

  function asDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('The image file could not be read.', { cause: reader.error }));
      reader.onabort = () => reject(new Error('Reading the image was cancelled.'));
      reader.readAsDataURL(blob);
    });
  }

  function decodeImage(dataURL) {
    return new Promise((resolve, reject) => {
      const picture = new Image();
      const timer = setTimeout(() => {
        picture.onload = picture.onerror = null;
        picture.src = '';
        reject(new Error('The image could not be decoded. Try another image.'));
      }, 20000);
      picture.onload = () => {
        clearTimeout(timer);
        const width = picture.naturalWidth;
        const height = picture.naturalHeight;
        picture.onload = picture.onerror = null;
        if (!width || !height) {
          reject(new Error('The image has invalid dimensions.'));
          return;
        }
        resolve({ width, height });
      };
      picture.onerror = () => {
        clearTimeout(timer);
        picture.onload = picture.onerror = null;
        reject(new Error('This image is damaged or cannot be opened. Choose a PNG, JPEG, WebP, or GIF image.'));
      };
      picture.src = dataURL;
    });
  }

  async function readImage(file) {
    checkFile(file, IMAGE_LIMIT, 'image');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mime = imageMime(bytes);
    const declaredMime = String(file.type || '').toLowerCase().replace('image/jpg', 'image/jpeg');
    if (!mime || (declaredMime && declaredMime !== mime)) {
      throw new Error('Choose a PNG, JPEG, WebP, or GIF image. SVG, HTML, and other file types are not supported.');
    }
    const dataURL = await asDataURL(new Blob([bytes], { type: mime }));
    const dimensions = await decodeImage(dataURL);
    return { dataURL, mime, width: dimensions.width, height: dimensions.height };
  }

  async function readChanges(file) {
    checkFile(file, CHANGES_LIMIT, 'changes');
    let parsed;
    try {
      const bytes = await file.arrayBuffer();
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (error) {
      throw new Error('This file could not be read as JSON changes.', { cause: error });
    }
    return validateState(parsed);
  }

  function hasTemporaryAssets(doc) {
    for (const element of doc.querySelectorAll('[src],[href],[poster],[style],style')) {
      for (const name of ['src', 'href', 'poster']) {
        if (/^\s*blob:/i.test(element.getAttribute(name) || '')) return true;
      }
      const css = element.tagName === 'STYLE' ? element.textContent : element.getAttribute('style') || '';
      if (/url\(\s*['"]?blob:/i.test(css)) return true;
    }
    return false;
  }

  function buildExport(baseHtml, state) {
    validateState(state);
    if (typeof baseHtml !== 'string' || !baseHtml.trim()) throw new Error('The original presentation is unavailable for export.');
    const parser = new DOMParser();
    const doc = parser.parseFromString(baseHtml, 'text/html');
    const seed = doc.querySelector('script#pe-seed[type="application/json"]');
    const manifest = doc.querySelector('script[type="__bundler/manifest"]');
    const template = doc.querySelector('script[type="__bundler/template"]');
    if (!seed || !manifest || !template) {
      throw new Error('The original presentation bundle is incomplete. Reload before exporting.');
    }
    let originalTemplate;
    try { originalTemplate = JSON.parse(template.textContent); } catch (error) {
      throw new Error('The original presentation template is damaged.', { cause: error });
    }
    if (typeof originalTemplate !== 'string' || hasTemporaryAssets(doc) ||
        hasTemporaryAssets(parser.parseFromString(originalTemplate, 'text/html'))) {
      throw new Error('The presentation contains temporary image links and cannot be exported safely.');
    }
    // Escape less-than signs in JSON script data, including a user's literal
    // closing-script text. All canonical bundle scripts remain untouched.
    seed.textContent = JSON.stringify(state).replace(/</g, '\\u003c');
    return new Blob(['<!DOCTYPE html>\n', doc.documentElement.outerHTML], { type: 'text/html;charset=utf-8' });
  }

  function download(blob, filename) {
    if (!(blob instanceof Blob)) throw new Error('The download could not be prepared.');
    if (typeof filename !== 'string' || !filename.trim()) throw new Error('A download filename is required.');
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    (document.body || document.documentElement).appendChild(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
      // Keep the URL alive while the browser starts its download, including
      // large self-contained presentations on slower devices.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  }

  window.PresentationEditorFiles = Object.freeze({
    loadDraft, saveDraft, readImage, readChanges, buildExport, download
  });
})();
