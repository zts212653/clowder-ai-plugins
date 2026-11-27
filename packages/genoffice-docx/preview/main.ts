import './styles.css';
import { startPreviewBridge } from './bridge';
import { checkPreviewSignature, previewRenderError, PreviewRenderError } from '../src/preview-errors';
import { previewFormatFor } from '../src/preview-protocol';

const root = document.getElementById('root');
if (!root) throw new Error('preview root missing');

const shell = document.createElement('div');
shell.className = 'preview-shell';
shell.innerHTML =
  '<div class="preview-status" role="status" aria-live="polite">正在接收文件…</div><div class="preview-stage"></div>';
root.append(shell);
const statusNode = shell.querySelector<HTMLElement>('.preview-status')!;
const stage = shell.querySelector<HTMLElement>('.preview-stage')!;

const setStatus = (text: string, tone: 'info' | 'error' = 'info', ready = true) => {
  statusNode.textContent = text;
  statusNode.dataset.tone = tone;
  document.documentElement.dataset.previewState = tone === 'error' ? 'error' : ready ? 'ready' : 'loading';
  if (tone !== 'error') delete document.documentElement.dataset.previewError;
};

const showError = (error: unknown) => {
  const failure = previewRenderError(error);
  setStatus(failure.message, 'error');
  document.documentElement.dataset.previewError = failure.code;
};

startPreviewBridge({
  onSnapshot: (snapshot) => {
    const format = previewFormatFor(snapshot.mediaType);
    document.documentElement.dataset.previewFileName = snapshot.fileName;
    if (!format) {
      showError(new PreviewRenderError('preview_format_unsupported'));
      return;
    }
    setStatus(`正在渲染 ${snapshot.fileName}`, 'info', false);
    void (async () => {
      checkPreviewSignature(format, new Uint8Array(snapshot.bytes));
      if (format === 'pdf') {
        const workerUrl = new URL('./pdf.worker.js', window.location.href).href;
        const [{ mountPdfPreview }, worker] = await Promise.all([
          import('./pdf'),
          import(/* @vite-ignore */ workerUrl),
        ]);
        await mountPdfPreview(stage, snapshot.bytes, (error) => {
          if (error) showError(error);
          else setStatus(snapshot.fileName);
        }, worker);
      } else if (format === 'pptx') {
        const { mountPptxPreview } = await import('./pptx');
        await mountPptxPreview(stage, snapshot.bytes, (error) => {
          if (error) showError(error);
          else setStatus(snapshot.fileName);
        });
      } else {
        const { mountDocxPreview } = await import('./docx');
        await mountDocxPreview(stage, snapshot.bytes);
        setStatus(snapshot.fileName);
      }
    })().catch(showError);
  },
  onError: () => showError(new PreviewRenderError('preview_failed')),
});
