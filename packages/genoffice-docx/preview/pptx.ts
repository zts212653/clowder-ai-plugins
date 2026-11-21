/**
 * Read-only PPTX surface.
 *
 * Parses the package in the renderer (browser shims for node:crypto/node:zlib/
 * Buffer), builds the same RenderSlide model the desktop app uses, decodes
 * embedded media to data URLs, and draws each page with the upstream SlideThumb.
 */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { openPptx } from '@genoffice/pptx-engine';
import { buildRenderSlide, type RenderNode } from '@genoffice/pptx-render';
import { BMP } from 'image-size/dist/types/bmp.js';
import { GIF } from 'image-size/dist/types/gif.js';
import { JPG } from 'image-size/dist/types/jpg.js';
import { PNG } from 'image-size/dist/types/png.js';
import { WEBP } from 'image-size/dist/types/webp.js';
import { SlideThumb } from '../../slides/src/renderer/SlideThumb';
import { assertPreviewImageSize } from '../src/preview-limits';
import './pptx.css';

const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};
const rasterHeaders = [PNG, JPG, GIF, BMP, WEBP];

function imageMime(ref: string): string | null {
  const ext = ref.slice(ref.lastIndexOf('.') + 1).toLowerCase();
  return IMAGE_MIME[ext] ?? null;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function collectImageUrls(nodes: readonly RenderNode[], urls: Set<string>): void {
  for (const node of nodes) {
    if (node.type === 'picture' && typeof node.dataUrl === 'string') urls.add(node.dataUrl);
    if ('fill' in node && node.fill?.kind === 'image' && node.fill.dataUrl) urls.add(node.fill.dataUrl);
    if (node.type === 'group') collectImageUrls(node.children, urls);
  }
}

async function decodeImages(urls: readonly string[]): Promise<Map<string, HTMLImageElement>> {
  const images = new Map<string, HTMLImageElement>();
  await Promise.all(
    urls.map(
      (url) =>
        new Promise<void>((resolve) => {
          const image = new Image();
          image.onload = () => {
            images.set(url, image);
            resolve();
          };
          image.onerror = () => resolve();
          image.src = url;
        }),
    ),
  );
  return images;
}

export async function mountPptxPreview(
  stage: HTMLElement,
  bytes: ArrayBuffer,
  onRendered: (error?: unknown) => void,
): Promise<void> {
  const opened = await openPptx(new Uint8Array(bytes));
  const media = (ref: string): string | undefined => {
    const data = opened.archive.readBytes(ref);
    const mime = data ? imageMime(ref) : null;
    if (!data || !mime) return undefined;
    // Read raster headers before creating a browser image or allocating a decoded bitmap.
    const raster = rasterHeaders.find((parser) => parser.validate(data));
    if (!raster && mime !== 'image/svg+xml') return undefined;
    if (raster) {
      const { width, height } = raster.calculate(data);
      if (width === undefined || height === undefined) return undefined;
      assertPreviewImageSize(width, height);
    }
    return `data:${mime};base64,${toBase64(data)}`;
  };

  if (opened.deck.slides.length === 0) throw new Error('preview_empty_presentation');
  const toolbar = document.createElement('div');
  toolbar.className = 'pdf-toolbar';
  toolbar.innerHTML = `
    <button type="button" data-control="prev" aria-label="上一页">‹</button>
    <output class="pdf-page" aria-live="polite"></output>
    <button type="button" data-control="next" aria-label="下一页">›</button>
    <span class="pdf-spacer"></span>
    <button type="button" data-control="smaller" aria-label="缩小">−</button>
    <span class="pdf-zoom"></span>
    <button type="button" data-control="larger" aria-label="放大">＋</button>
  `;
  const viewport = document.createElement('div');
  viewport.className = 'pptx-deck';
  const page = document.createElement('div');
  page.className = 'pptx-page';
  viewport.append(page);
  stage.append(toolbar, viewport);
  const root = createRoot(page);
  const prev = toolbar.querySelector<HTMLButtonElement>('[data-control=prev]')!;
  const next = toolbar.querySelector<HTMLButtonElement>('[data-control=next]')!;
  const pageLabel = toolbar.querySelector('output')!;
  const zoomLabel = toolbar.querySelector('.pdf-zoom')!;
  const count = opened.deck.slides.length;
  let current = 0;
  let zoom = 1;
  let revision = 0;
  const render = async (expected: number) => {
    const width = Math.max(300, viewport.clientWidth - 24) * zoom;
    const source = opened.deck.slides[current]!;
    const slide = buildRenderSlide(source, opened.deck.size, { fitWidthPx: width, slideNo: current + 1, media });
    const urls = new Set<string>();
    if (slide.background?.kind === 'image' && slide.background.dataUrl) urls.add(slide.background.dataUrl);
    collectImageUrls(slide.nodes, urls);
    const images = await decodeImages([...urls]);
    if (expected !== revision) return;
    for (const image of images.values()) assertPreviewImageSize(image.naturalWidth, image.naturalHeight);
    root.render(createElement(SlideThumb, { slide, images, width }));
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    document.documentElement.dataset.previewPages = String(count);
    document.documentElement.dataset.previewPage = String(current + 1);
    document.documentElement.dataset.previewFormat = 'pptx';
    onRendered();
  };
  const renderCurrentSlide = () => {
    const expected = ++revision;
    prev.disabled = current === 0;
    next.disabled = current + 1 === count;
    pageLabel.textContent = `${current + 1} / ${count}`;
    return render(expected).catch((error: unknown) => {
      if (expected !== revision) return;
      root.render(null);
      onRendered(error);
    });
  };
  prev.onclick = () => { current = Math.max(0, current - 1); void renderCurrentSlide(); };
  next.onclick = () => { current = Math.min(count - 1, current + 1); void renderCurrentSlide(); };
  toolbar.querySelector<HTMLButtonElement>('[data-control=smaller]')!.onclick = () => {
    zoom = Math.max(1, zoom - 0.25);
    void renderCurrentSlide();
  };
  toolbar.querySelector<HTMLButtonElement>('[data-control=larger]')!.onclick = () => {
    zoom = Math.min(3, zoom + 0.25);
    void renderCurrentSlide();
  };
  await document.fonts.load('16px Carlito');
  await renderCurrentSlide();
  const observer = new ResizeObserver(() => void renderCurrentSlide());
  observer.observe(stage);
  window.addEventListener('pagehide', () => {
    revision += 1;
    observer.disconnect();
    root.unmount();
  }, { once: true });
}
