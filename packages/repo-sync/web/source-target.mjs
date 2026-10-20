import { continuationField } from './continuation-view.mjs';

export function sourceTargetForm(state, tags, esc, sha, automatic = true) {
  const open = !state.queue.length;
  return `<details ${open ? 'open' : ''} class="v3-target-fold"><summary><b>选择本轮同步终点</b><span class="block-brief">最新 / tag / 完整 commit；逐笔接收，不跳过中间 PR</span></summary>
  <form data-form="${automatic ? 'synchronize' : 'discover'}">
  <div class="target-kind-row">
    <label>目标类型<select name="targetKind"><option value="latest">当前上游分支最新版本</option><option value="tag">指定 tag</option><option value="commit">指定完整 commit SHA</option></select></label>
    <div class="target-help">目标只是终点，不是一次搬运全部更新。完整 SHA 必须是 40 位，且位于来源分支的 first-parent 合入边界上。</div>
  </div>
  <div class="target-row">
    <label>目标 tag 名称 / 完整 commit SHA<input name="targetValue" placeholder="v2.0.0 或 40 位完整 SHA" list="continuous-tags" autocomplete="off" spellcheck="false"></label>
    <button type="button" data-action="tags">读取可用 tag</button>
  </div>
  <datalist id="continuous-tags">${tags.map((tag) => `<option value="${esc(tag.name)}"></option>`).join('')}</datalist>
  <p class="target-help">系统自动识别 PR 和无关联 PR 的主干提交，按顺序逐笔同步；来源会明确标示。仅关联不明确或读取失败时暂停。目标必须在配置的来源分支上，且不能截断一个 PR。</p>
  ${automatic ? continuationField() + '<label class="target-automerge"><input type="checkbox" name="autoMerge">本轮允许平台自动合入（默认关闭；仅在等待审核时可修改）</label>' : ''}
  <div class="target-actions">
    <button type="submit" class="primary">${automatic ? '开始同步 →' : '读取到目标版本的 PR 清单 →'}</button>
    <button type="button" data-preview-sync>对比目标范围（只读）</button>
  </div>
  <p class="note-line">对比是只读的，不写台账、不改 ref；真正开始时会重新核验目标、配置与内部 HEAD。标签移动时会暂停。只接收版本内容请新增“按版本更新”项目。</p>
  </form></details>
  ${state.syncTarget ? `<p class="target-current">本轮终点：${esc(state.syncTarget.kind === 'latest' ? '扫描时最新版本' : state.syncTarget.value)} · ${sha(state.syncTarget.commit)}${state.accepted.upstream === state.syncTarget.commit ? ' · 本轮终点已接收' : ''}<br>扫描时上游最新：${sha(state.latest)}${state.latest !== state.syncTarget.commit ? '（仍有本轮以外的后续更新）' : ''}</p>` : ''}`;
}
