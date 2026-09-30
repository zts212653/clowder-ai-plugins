import assert from 'node:assert/strict';
import test from 'node:test';

import { renderTypedMediaNotice } from './media-notice.js';

test('typed media notices render every unavailable enum without relying on fileName', () => {
  const reasons = {
    source_expired: '来源已过期',
    timeout: '处理超时',
    unavailable: '无法获取',
  } as const;
  for (const [reason, label] of Object.entries(reasons)) {
    assert.equal(renderTypedMediaNotice({
      elementId: `unavailable-${reason}`,
      kind: 'media_unavailable',
      payload: { type: 'video', reason },
    }), `⚠️ 媒体不可用：视频（${label}）`);
  }
});

test('media warning identifies its referenced media by display name or type', () => {
  const stages = { transcription: '转写', preview: '预览' } as const;
  const reasons = { timeout: '超时', processing_failed: '处理失败' } as const;
  for (const [stage, stageLabel] of Object.entries(stages)) {
    for (const [reason, reasonLabel] of Object.entries(reasons)) {
      const warning = {
        elementId: `warning-${stage}-${reason}`, kind: 'media_warning',
        payload: { mediaElementId: 'media-1', stage, reason },
      };
      assert.equal(renderTypedMediaNotice(warning, { elements: [
        { elementId: 'media-1', kind: 'media_ref', payload: { type: 'audio', reference: 'hmr_1', fileName: 'voice.opus' } },
      ] }), `⚠️ 媒体处理警告：voice.opus（${stageLabel}${reasonLabel}）`);
      assert.equal(renderTypedMediaNotice(warning, { elements: [
        { elementId: 'media-1', kind: 'media_ref', payload: { type: 'audio', reference: 'hmr_1' } },
      ] }), `⚠️ 媒体处理警告：音频（${stageLabel}${reasonLabel}）`);
    }
  }
});

test('only typed notice elements render and malformed notices log only their elementId', () => {
  assert.equal(renderTypedMediaNotice({ elementId: 'text-1', kind: 'text', payload: { text: 'body' } }), undefined);
  assert.equal(renderTypedMediaNotice({
    elementId: 'media-1', kind: 'media_ref', payload: { type: 'image', reference: 'hmr_1' },
  }), undefined);
  const warned: string[] = [];
  assert.equal(renderTypedMediaNotice({
    elementId: 'bad-1', kind: 'media_warning', payload: { privateLocator: 'must-not-log' },
  }, { warnInvalid: elementId => warned.push(elementId) }), undefined);
  assert.deepEqual(warned, ['bad-1']);
});
