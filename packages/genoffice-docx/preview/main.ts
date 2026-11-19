import './styles.css';
import { startPreviewBridge, type PreviewBridgeError } from './bridge';
import { mountPdfPreview } from './pdf';
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

const setStatus = (text: string, tone: 'info' | 'error' = 'info') => {
  statusNode.textContent = text;
  statusNode.dataset.tone = tone;
  document.documentElement.dataset.previewState = tone === 'error' ? 'error' : 'ready';
};

const showError = (error: PreviewBridgeError | Error) => {
  const code = 'code' in error && typeof error.code === 'string' ? error.code : 'preview_failed';
  setStatus(`无法预览：${code}`, 'error');
  document.documentElement.dataset.previewError = code;
};

startPreviewBridge({
  onSnapshot: (snapshot) => {
    const format = previewFormatFor(snapshot.mediaType);
    document.documentElement.dataset.previewFileName = snapshot.fileName;
    if (!format) {
      showError(new Error('preview_media_type_unsupported'));
      return;
    }
    setStatus(`正在渲染 ${snapshot.fileName}`);
    void mountPdfPreview(stage, snapshot.bytes)
      .then(() => setStatus(snapshot.fileName))
      .catch((error: unknown) => showError(error instanceof Error ? error : new Error(String(error))));
  },
  onError: showError,
});
