import { esc } from './ui.mjs';

export function issueReferenceNotes(source) {
  const notes = source?.issueReferenceNotes ?? [];
  if (!notes.length) return '';
  return `<section class="delivery-note" aria-label="未确认的 Issue 文本提及"><h4>未确认的 Issue 文本提及（${notes.length}）</h4><details class="tech"><summary>说明</summary><div class="tech-copy">以下编号来自提交消息或 PR 文本，GitHub 返回 404（不存在或当前账号不可见）。它们不作为已确认关联，不创建或关闭内部 Issue；其他代码与已确认 Issue 继续同步。如确需关联，请核对上游编号与读取权限。</div></details><ul>${notes.map((note) => `<li>${esc(note.repo)}#${esc(note.number)} · 未确认，已跳过</li>`).join('')}</ul></section>`;
}
