import type { IssueInvestigation } from '../model/issue-coordination.js';
import { focusLabels, type AffectedSystem, type RoutingFocus } from '../classification/routing-context.js';
import { systemLabels } from '../classification/issue-context.js';

export function IssueRoutingEditor({ value, change }: { value: IssueInvestigation; change: (value: IssueInvestigation) => void }) {
  const selected = value.affectedSystems === undefined ? 'auto' : [...value.affectedSystems].sort().join(',') || 'unknown';
  return <>
    <label>受影响操作系统
      <select aria-label="受影响操作系统" value={selected} onChange={event => change({ ...value,
        affectedSystems: event.target.value === 'auto' ? undefined : event.target.value === 'unknown' ? [] : event.target.value.split(',') as AffectedSystem[] })}>
        <option value="auto">采用猫研判 / 原文判断</option>
        <option value="unknown">待判断</option>
        <option value="macos">macOS</option>
        <option value="windows">Windows</option>
        <option value="macos,windows">macOS 与 Windows（需拆分）</option>
        <option value="other">其他系统</option>
        {!['auto', 'unknown', 'macos', 'windows', 'macos,windows', 'other'].includes(selected) &&
          <option value={selected}>{value.affectedSystems!.map(system => systemLabels[system]).join('、')}（需拆分）</option>}
      </select>
    </label>
    <label>派工职责
      <select aria-label="派工职责" value={value.routingFocus ?? 'auto'} onChange={event => change({ ...value,
        routingFocus: event.target.value === 'auto' ? undefined : event.target.value as RoutingFocus })}>
        <option value="auto">采用猫研判 / 原文判断</option>
        {Object.entries(focusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
    </label>
    <p>保存后用于派工；人工确认优先。系统待判断、其他系统或跨平台问题需先明确处理范围。</p>
  </>;
}
