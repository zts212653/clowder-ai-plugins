import { continuationField } from './continuation-view.mjs';
export function sourceTargetForm(state, tags, esc, sha, automatic = true) {
  return `<details ${state.queue.length ? '' : 'open'}><summary>选择本轮同步终点（逐笔接收）</summary>
  <form data-form="${automatic ? 'synchronize' : 'discover'}"><label>目标类型<select name="targetKind"><option value="latest">当前上游分支最新版本</option><option value="tag">指定 tag</option><option value="commit">指定完整 commit SHA</option></select></label>
  <label>目标 tag 名称 / 完整 commit SHA<input name="targetValue" placeholder="v2.0.0 或完整 SHA" list="continuous-tags"></label>
  <datalist id="continuous-tags">${tags.map((tag) => `<option value="${esc(tag.name)}"></option>`).join('')}</datalist>
  <p>系统自动识别 PR 和无关联 PR 的主干提交，按顺序逐笔同步；来源会明确标示。仅关联不明确或读取失败时暂停。</p>
  ${automatic ? continuationField() + '<label><input type="checkbox" name="autoMerge">本轮允许平台自动合入（默认关闭）</label>' : ''}<button type="button" data-action="tags">读取可用 tag</button><button type="submit" class="primary">${automatic ? '开始同步 →' : '读取到目标版本的 PR 清单 →'}</button><button type="button" data-preview-sync>预览同步范围（只读）</button>
  <details class="tech"><summary>为什么？</summary><div class="tech-copy">目标只是终点，不是一次搬运全部更新。一次接收一个完整 PR，或一笔自动识别的主干提交；本笔在内部合入并核验后，根据接收节奏连续处理或等待你确认下一笔。目标必须在配置的来源分支上，且不能截断一个 PR。独立发布分支上的 tag 可能不满足该条件；只接收版本内容请新增“按版本更新”项目。标签移动时会暂停。</div></details></form></details>
  ${state.syncTarget ? `<p>本轮终点：${esc(state.syncTarget.kind === 'latest' ? '扫描时最新版本' : state.syncTarget.value)} · ${sha(state.syncTarget.commit)}${state.accepted.upstream === state.syncTarget.commit ? ' · 本轮终点已接收' : ''}<br>扫描时上游最新：${sha(state.latest)}${state.latest !== state.syncTarget.commit ? '（仍有本轮以外的后续更新）' : ''}</p>` : ''}`;
}
