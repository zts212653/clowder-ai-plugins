import {
  isMediaUnavailableMessageElement,
  isMediaWarningMessageElement,
} from '@clowder-ai/plugin-sdk';

const MEDIA_TYPE_LABEL = {
  image: '图片',
  file: '文件',
  audio: '音频',
  video: '视频',
} as const;

const UNAVAILABLE_REASON_LABEL = {
  source_expired: '来源已过期',
  timeout: '处理超时',
  unavailable: '无法获取',
} as const;

const WARNING_STAGE_LABEL = {
  transcription: '转写',
  preview: '预览',
} as const;

const WARNING_REASON_LABEL = {
  timeout: '超时',
  processing_failed: '处理失败',
} as const;

export interface TypedMediaNoticeOptions {
  readonly elements?: readonly unknown[];
  readonly warnInvalid?: (elementId: string) => void;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function referencedMediaLabel(elements: readonly unknown[], mediaElementId: string): string | undefined {
  const referenced = elements.find((candidate) => (
    object(candidate) && candidate.elementId === mediaElementId && candidate.kind === 'media_ref'
  ));
  if (!object(referenced) || !object(referenced.payload)) return undefined;
  if (typeof referenced.payload.fileName === 'string' && referenced.payload.fileName.trim() !== '') {
    return referenced.payload.fileName;
  }
  const type = referenced.payload.type;
  return typeof type === 'string' && type in MEDIA_TYPE_LABEL
    ? MEDIA_TYPE_LABEL[type as keyof typeof MEDIA_TYPE_LABEL]
    : undefined;
}

export function renderTypedMediaNotice(
  element: unknown,
  options: TypedMediaNoticeOptions = {},
): string | undefined {
  if (isMediaUnavailableMessageElement(element)) {
    const label = element.payload.fileName ?? MEDIA_TYPE_LABEL[element.payload.type];
    return `⚠️ 媒体不可用：${label}（${UNAVAILABLE_REASON_LABEL[element.payload.reason]}）`;
  }
  if (isMediaWarningMessageElement(element)) {
    const label = referencedMediaLabel(options.elements ?? [], element.payload.mediaElementId) ?? '媒体';
    return `⚠️ 媒体处理警告：${label}（${WARNING_STAGE_LABEL[element.payload.stage]}${WARNING_REASON_LABEL[element.payload.reason]}）`;
  }
  if (object(element) && (element.kind === 'media_unavailable' || element.kind === 'media_warning')) {
    options.warnInvalid?.(typeof element.elementId === 'string' ? element.elementId : 'unknown');
  }
  return undefined;
}
