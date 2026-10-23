import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { createPresentation, addTitleSlide, addContentSlide, savePresentation } from '@office-kit/pptx';
import { inspectNative, validatePptxZip } from '../src/native-viewer.js';

const smallZip = (extra = {}) => zipSync({
  '[Content_Types].xml': strToU8('<Types/>'),
  'ppt/presentation.xml': strToU8('<p:presentation><p:sldIdLst><p:sldId id="1"/></p:sldIdLst></p:presentation>'),
  'ppt/slides/slide1.xml': strToU8('<p:sld/>'),
  ...extra
});

test('inspects a real generated PowerPoint and counts its slides', async () => {
  const presentation = createPresentation();
  addTitleSlide(presentation, 'Native preview test');
  addContentSlide(presentation, { title: 'Second slide', body: 'A browser-safe preview.' });
  const bytes = await savePresentation(presentation);
  const metadata = await validatePptxZip(bytes);
  assert.equal(metadata.slideCount, 2);
  assert.ok(metadata.expandedBytes > bytes.length);
  assert.deepEqual(await inspectNative(new Blob([bytes]), 'pptx'), { slideCount: 2 });
});

test('rejects archive traversal paths before parsing presentation content', async () => {
  await assert.rejects(validatePptxZip(smallZip({ '../unexpected.xml': strToU8('x') })), /invalid file paths/i);
});

test('rejects archives whose declared decompressed size exceeds 200 MB', async () => {
  const bytes = smallZip();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const directory = view.getUint32(bytes.length - 6, true);
  view.setUint32(directory + 24, 201 * 1024 * 1024, true);
  await assert.rejects(validatePptxZip(bytes), /200 MB/i);
});

test('stream validation catches forged small decompressed sizes', async () => {
  const bytes = smallZip({ 'ppt/media/compressed.bin': strToU8('A'.repeat(500000)) });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let position = view.getUint32(bytes.length - 6, true);
  while (view.getUint32(position, true) === 0x02014b50) {
    const nameLength = view.getUint16(position + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(position + 46, position + 46 + nameLength));
    if (name.endsWith('compressed.bin')) {
      const local = view.getUint32(position + 42, true);
      view.setUint32(position + 24, 10, true);
      view.setUint32(local + 22, 10, true);
      break;
    }
    position += 46 + nameLength + view.getUint16(position + 30, true) + view.getUint16(position + 32, true);
  }
  await assert.rejects(validatePptxZip(bytes), /declared size/i);
});

test('rejects over 500 slide references even when references reuse one part', async () => {
  const xml = '<p:presentation><p:sldIdLst>' + '<p:sldId id="1"/>'.repeat(501) + '</p:sldIdLst></p:presentation>';
  await assert.rejects(validatePptxZip(smallZip({ 'ppt/presentation.xml': strToU8(xml) })), /500 slides/i);
});

test('rejects truncated archives and unsupported ZIP64 metadata', async () => {
  const bytes = smallZip();
  await assert.rejects(validatePptxZip(bytes.subarray(0, bytes.length - 3)), /complete PowerPoint archive/i);
  const zip64 = smallZip();
  new DataView(zip64.buffer).setUint16(zip64.length - 12, 65535, true);
  await assert.rejects(validatePptxZip(zip64), /ZIP64/i);
});

test('checks the original upload size before reading file bytes', async () => {
  const file = { size: 40 * 1024 * 1024 + 1, arrayBuffer() { throw new Error('must not read'); } };
  await assert.rejects(inspectNative(file, 'pptx'), /40 MB/i);
});

test('rejects unsupported formats without running a parser', async () => {
  await assert.rejects(inspectNative(new Blob(['test']), 'html'), /supports PowerPoint/i);
});
