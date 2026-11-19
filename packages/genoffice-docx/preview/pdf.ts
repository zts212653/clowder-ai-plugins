/**
 * Read-only PDF surface: one page at a time, fit-width base scale, zoom, and a
 * selectable text layer. No annotations, no write path, no network.
 */
import * as pdfjs from 'pdfjs-dist';
import type { PDFPageProxy, RenderTask } from 'pdfjs-dist';

const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;

export async function mountPdfPreview(
  stage: HTMLElement,
  bytes: ArrayBuffer,
): Promise<void> {
  const workerUrl = new URL('./pdf.worker.js', window.location.href).href;
  const { WorkerMessageHandler } = await import(/* @vite-ignore */ workerUrl);
  Object.assign(globalThis, { pdfjsWorker: { WorkerMessageHandler } });

  const loading = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
  });
  const doc = await loading.promise;

  const toolbar = document.createElement('div');
  toolbar.className = 'pdf-toolbar';
  toolbar.innerHTML = `
    <button type="button" data-action="prev" aria-label="上一页">‹</button>
    <span class="pdf-page" data-role="page">1 / ${doc.numPages}</span>
    <button type="button" data-action="next" aria-label="下一页">›</button>
    <span class="pdf-spacer"></span>
    <button type="button" data-action="zoom-out" aria-label="缩小">−</button>
    <span class="pdf-zoom" data-role="zoom">100%</span>
    <button type="button" data-action="zoom-in" aria-label="放大">＋</button>
    <div class="pdf-search" role="search">
      <input type="search" aria-label="搜索 PDF 文本" placeholder="搜索文本" required>
      <button type="button" data-role="search">查找</button>
      <output aria-live="polite"></output>
    </div>
  `;
  const pageLabel = toolbar.querySelector<HTMLElement>('[data-role="page"]')!;
  const zoomLabel = toolbar.querySelector<HTMLElement>('[data-role="zoom"]')!;
  const searchForm = toolbar.querySelector('.pdf-search')!;
  const searchInput = searchForm.querySelector('input')!;
  const searchResult = searchForm.querySelector('output')!;

  const viewportNode = document.createElement('div');
  viewportNode.className = 'pdf-viewport';
  const pageNode = document.createElement('div');
  pageNode.className = 'pdf-page-node';
  const canvas = document.createElement('canvas');
  canvas.className = 'pdf-canvas';
  const textLayer = document.createElement('div');
  textLayer.className = 'textLayer';
  pageNode.append(canvas, textLayer);
  viewportNode.append(pageNode);
  stage.append(toolbar, viewportNode);

  let pageNumber = 1;
  let zoom = 1;
  let renderTask: RenderTask | null = null;
  let renderToken = 0;

  const fitScale = (page: PDFPageProxy): number => {
    const available = Math.max(320, viewportNode.clientWidth - 24);
    return available / page.getViewport({ scale: 1 }).width;
  };

  const render = async (): Promise<void> => {
    const token = ++renderToken;
    renderTask?.cancel();
    renderTask = null;
    const page = await doc.getPage(pageNumber);
    if (token !== renderToken) return;
    const scale = fitScale(page) * zoom;
    const viewport = page.getViewport({ scale });
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    pageNode.style.width = `${viewport.width}px`;
    pageNode.style.height = `${viewport.height}px`;
    textLayer.style.width = `${viewport.width}px`;
    textLayer.style.height = `${viewport.height}px`;
    textLayer.style.setProperty('--scale-factor', String(viewport.scale));
    textLayer.replaceChildren();

    const context = canvas.getContext('2d');
    if (!context) throw new Error('preview_canvas_unavailable');
    const task = page.render({
      canvasContext: context,
      viewport,
      transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
    });
    renderTask = task;
    await task.promise.catch((error: unknown) => {
      if ((error as { name?: string } | null)?.name !== 'RenderingCancelledException') throw error;
    });
    if (token !== renderToken) return;

    const layer = new pdfjs.TextLayer({
      textContentSource: page.streamTextContent(),
      container: textLayer,
      viewport,
    });
    await layer.render();

    pageLabel.textContent = `${pageNumber} / ${doc.numPages}`;
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    document.documentElement.dataset.previewPages = String(doc.numPages);
    document.documentElement.dataset.previewPage = String(pageNumber);
    toolbar.querySelector<HTMLButtonElement>('[data-action="prev"]')!.disabled = pageNumber <= 1;
    toolbar.querySelector<HTMLButtonElement>('[data-action="next"]')!.disabled =
      pageNumber >= doc.numPages;
  };

  const go = (delta: number) => {
    const next = Math.min(Math.max(pageNumber + delta, 1), doc.numPages);
    if (next === pageNumber) return;
    pageNumber = next;
    void render();
  };

  toolbar.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    if (!target) return;
    switch (target.dataset.action) {
      case 'prev':
        go(-1);
        break;
      case 'next':
        go(1);
        break;
      case 'zoom-in':
        zoom = Math.min(MAX_ZOOM, Math.round((zoom + ZOOM_STEP) * 100) / 100);
        void render();
        break;
      case 'zoom-out':
        zoom = Math.max(MIN_ZOOM, Math.round((zoom - ZOOM_STEP) * 100) / 100);
        void render();
        break;
      default:
        break;
    }
  });

  let searchRequest = 0;
  const search = () => {
    const query = searchInput.value.trim().toLocaleLowerCase();
    if (!query) return;
    const request = ++searchRequest;
    const startPage = pageNumber;
    searchResult.textContent = '正在搜索…';
    void (async () => {
      for (let offset = 0; offset < doc.numPages && request === searchRequest; offset += 1) {
        const candidate = ((startPage + offset - 1) % doc.numPages) + 1;
        const page = await doc.getPage(candidate);
        const content = (await page.getTextContent()).items
          .flatMap((item) => ('str' in item ? [item.str] : []))
          .join(' ')
          .toLocaleLowerCase();
        if (request !== searchRequest) return;
        if (!content.includes(query)) continue;
        pageNumber = candidate;
        await render();
        if (request === searchRequest) searchResult.textContent = `找到，第 ${candidate} 页`;
        return;
      }
      if (request === searchRequest) searchResult.textContent = '没有匹配的文本';
    })().catch(() => {
      if (request === searchRequest) searchResult.textContent = '无法搜索此文档';
    });
  };
  searchForm.querySelector('button')!.addEventListener('click', search);
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') search();
  });

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target === searchInput) return;
    if (event.key === 'ArrowLeft' || event.key === 'PageUp') go(-1);
    if (event.key === 'ArrowRight' || event.key === 'PageDown') go(1);
    if (event.key === '+' || event.key === '=') {
      zoom = Math.min(MAX_ZOOM, Math.round((zoom + ZOOM_STEP) * 100) / 100);
      void render();
    }
    if (event.key === '-') {
      zoom = Math.max(MIN_ZOOM, Math.round((zoom - ZOOM_STEP) * 100) / 100);
      void render();
    }
  };
  window.addEventListener('keydown', onKeyDown);

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const observer = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => void render(), 150);
  });
  observer.observe(viewportNode);

  window.addEventListener(
    'pagehide',
    () => {
      observer.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      renderTask?.cancel();
      if (resizeTimer) clearTimeout(resizeTimer);
      searchRequest += 1;
      renderToken += 1;
      void loading.destroy();
    },
    { once: true },
  );

  await render();
}

