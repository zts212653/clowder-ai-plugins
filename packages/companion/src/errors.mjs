const messages = {
  permission_required: '请点击开始聊天，或在系统提示中允许本次使用',
  session_required: '连接已结束 · 点击开始聊天继续',
  busy: '上一段交流正在收尾 · 稍后再开始',
  selection_changed: '猫猫球的选择已更新 · 点击开始聊天继续',
  carrier_unavailable: '实时语音暂不可用 · 可以打开聊天继续交流',
  cancelled: '操作已取消',
  unconfirmed: '发送尚未确认 · 文字已保留，可检查聊天记录后重试',
};
export function explainError(error) {
  if (error?.name === 'NotAllowedError') return '未获得麦克风权限 · 请在系统设置中允许后重试';
  // hasOwn: `??` does not stop a truthy prototype hit — {code:'constructor'}
  // would render `function Object() { [native code] }` as the user message.
  if (Object.hasOwn(messages, error?.code)) return messages[error.code];
  return '连接暂时不可用 · 请重试或打开聊天继续';
}
