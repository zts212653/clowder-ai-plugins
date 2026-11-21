import assert from 'node:assert/strict';
import test from 'node:test';
import { readPreviewArchive } from './preview-archive.js';
import { checkPreviewSignature, previewRenderError } from './preview-errors.js';
import { assertPreviewImageSize, pdfCanvasRatio, PDF_CANVAS_BYTES } from './preview-limits.js';

const bytes = (...values: number[]) => Uint8Array.of(...values);

test('PDF zoom retains the viewport and reduces only the canvas density at DPR 2', () => {
  assert.equal(pdfCanvasRatio(1100, 1556, 2), 2);
  const width = 2475;
  const height = 3501;
  const ratio = pdfCanvasRatio(width, height, 2);
  assert.ok(ratio >= 1 && ratio < 2);
  assert.ok(Math.floor(width * ratio) * Math.floor(height * ratio) * 4 <= PDF_CANVAS_BYTES);
});

test('PDF zoom preserves 300% A4 on a 2560px display at DPR 1 and 2', () => {
  const width = 2560 * 3;
  const height = (width * 297) / 210;
  for (const dpr of [1, 2]) {
    const ratio = pdfCanvasRatio(width, height, dpr);
    assert.ok(ratio >= 0.5 && ratio < 1);
    assert.ok(Math.floor(width * ratio) * Math.floor(height * ratio) * 4 <= PDF_CANVAS_BYTES);
  }
  assert.throws(() => pdfCanvasRatio(12_000, 12_000, 1), { code: 'preview_limit_exceeded' });
});

test('the image pixel budget rejects larger dimensions before handing pixels to the browser', () => {
  assert.doesNotThrow(() => assertPreviewImageSize(10_000, 5000));
  assert.throws(() => assertPreviewImageSize(10_000, 5001), { code: 'preview_limit_exceeded' });
});

function entry(declared: number, chunks: Uint8Array[]) {
  let data: ((chunk: Uint8Array) => void) | undefined;
  let end: (() => void) | undefined;
  let started = false;
  let paused = false;
  const stream = {
    on(event: string, callback: never) {
      if (event === 'data') data = callback;
      if (event === 'end') end = callback;
      return this;
    },
    pause() {
      paused = true;
      return this;
    },
    resume() {
      started = true;
      chunks.forEach((chunk) => { if (!paused) data?.(chunk); });
      if (!paused) end?.();
      return this;
    },
  };
  return {
    dir: false,
    _data: { uncompressedSize: declared },
    internalStream: () => stream,
    get started() { return started; },
    get paused() { return paused; },
  };
}

test('archive budget admits small parts and rejects excessive declared sizes before streaming', async () => {
  const source = entry(3, [bytes(1), bytes(2, 3)]);
  assert.deepEqual(await readPreviewArchive({ 'ppt/presentation.xml': source }), new Map([
    ['ppt/presentation.xml', bytes(1, 2, 3)],
  ]));

  const excessive = entry(32 * 1024 * 1024 + 1, []);
  await assert.rejects(readPreviewArchive({ first: source, excessive }), { code: 'preview_limit_exceeded' });
  assert.equal(excessive.started, false);

  const part = entry(32 * 1024 * 1024, []);
  const total = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i), part]));
  await assert.rejects(readPreviewArchive(total), { code: 'preview_limit_exceeded' });
  assert.equal(part.started, false);
});

test('archive reader rejects a stream that exceeds its declared size or ends early', async () => {
  const oversized = entry(2, [bytes(1, 2), bytes(3)]);
  await assert.rejects(readPreviewArchive({ source: oversized }), { code: 'preview_limit_exceeded' });
  assert.equal(oversized.paused, true);
  await assert.rejects(readPreviewArchive({ source: entry(3, [bytes(1, 2)]) }), { code: 'preview_file_damaged' });
});

test('preview reports actionable format, password, resource limit and damage errors', () => {
  checkPreviewSignature('pdf', new TextEncoder().encode('%PDF-1.7'));
  checkPreviewSignature('pptx', bytes(0x50, 0x4b, 0x03, 0x04));
  assert.throws(() => checkPreviewSignature('pptx', bytes(0xd0, 0xcf, 0x11, 0xe0)), {
    code: 'preview_format_unsupported',
  });
  assert.equal(previewRenderError(Object.assign(new Error('password'), { name: 'PasswordException' })).code,
    'preview_password_required');
  assert.equal(previewRenderError(new Error('Image exceeded maximum allowed size and was removed.')).code,
    'preview_limit_exceeded');
  assert.match(previewRenderError(new Error('other')).message, /损坏.*默认应用/u);
});
