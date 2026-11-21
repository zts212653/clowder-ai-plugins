import { PreviewRenderError } from './preview-errors.js';

export const PREVIEW_IMAGE_PIXELS = 50_000_000;
export const PDF_CANVAS_BYTES = 128 * 1024 * 1024;

export function assertPreviewImageSize(width: number, height: number): void {
  if (width * height > PREVIEW_IMAGE_PIXELS) throw new PreviewRenderError('preview_limit_exceeded');
}

export function pdfCanvasRatio(width: number, height: number, devicePixelRatio: number): number {
  const bytes = width * height * 4;
  if (bytes > PDF_CANVAS_BYTES) throw new PreviewRenderError('preview_limit_exceeded');
  return Math.min(2, devicePixelRatio || 1, Math.sqrt(PDF_CANVAS_BYTES / bytes));
}
