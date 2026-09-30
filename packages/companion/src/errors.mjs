const messages = {
  permission_required: '请点击语音通话，或在系统提示中允许本次使用',
  session_required: '连接已结束 · 点击语音通话继续',
  busy: '会话暂时被占用，请稍后重试',
  selection_changed: '猫猫球的选择已更新 · 点击语音通话继续',
  carrier_unavailable: '实时语音暂不可用 · 可以打开聊天继续交流',
  cancelled: '操作已取消',
  unconfirmed: '发送尚未确认 · 文字已保留，可检查聊天记录后重试',
};
export function explainError(error) {
  if (error?.name === 'NotAllowedError') return '未获得麦克风权限 · 请在系统设置中允许后重试';
  return messages[error?.code] ?? '连接暂时不可用 · 请重试或打开聊天继续';
}
