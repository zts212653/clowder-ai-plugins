import type { PreviewFormat } from './preview-protocol.js';

const messages = {
  preview_password_required: '此文件受密码保护，请用默认应用打开并输入密码。',
  preview_file_damaged: '文件可能损坏或不完整，请用默认应用检查。',
  preview_format_unsupported: '此文件格式暂不支持预览，请用默认应用打开。',
  preview_limit_exceeded: '文件内容超出预览限制，请用默认应用打开。',
  preview_failed: '无法加载预览，请用默认应用打开。',
} as const;

export class PreviewRenderError extends Error {
  constructor(readonly code: keyof typeof messages, options?: ErrorOptions) {
    super(messages[code], options);
  }
}

export function previewRenderError(error: unknown): PreviewRenderError {
  if (error instanceof PreviewRenderError) return error;
  if (error instanceof Error) {
    if (error.name === 'PasswordException') return new PreviewRenderError('preview_password_required', { cause: error });
    if (error.message === 'Image exceeded maximum allowed size and was removed.') {
      return new PreviewRenderError('preview_limit_exceeded', { cause: error });
    }
  }
  return new PreviewRenderError('preview_file_damaged', { cause: error });
}

export function checkPreviewSignature(format: PreviewFormat, bytes: Uint8Array): void {
  const prefix = bytes.subarray(0, 1024);
  const pdf = new TextDecoder().decode(prefix).includes('%PDF-');
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06));
  if (format === 'pdf' ? !pdf : !zip) throw new PreviewRenderError('preview_format_unsupported');
}
