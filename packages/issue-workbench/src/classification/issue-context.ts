import type { IssueClassification } from '../model/issue-coordination.js';
import type { IssueSourceFact } from '../model/issue-source.js';

export const originLabels = { internal: '内源问题', external: '外部问题', common: '共性问题', unknown: '待判断' } as const;
export const systemLabels = { windows: 'Windows', macos: 'macOS', other: '其他系统' } as const;
export interface IssueContextClassification {
  ruleVersion: 'origin-system-v1';
  basis: 'title' | 'description';
  origin: keyof typeof originLabels;
  systems: (keyof typeof systemLabels)[];
  systemsSource?: 'human' | 'cat' | 'source';
  originEvidence: string[];
  systemEvidence: string[];
}

const internal = /\bcode[ -]?agent\b|\bcode[ -]?hub\b|内源|内部(?:版|环境|平台|系统|部署)|公司内网/i;
const external = /(?:开源|社区|公开|外部|上游)(?:版|环境|平台|部署|问题)|\b(?:public|community|open[ -]source) (?:edition|version|deployment)\b/i;
const common = /共性问题|通用问题|内外(?:部|源)?(?:版本?)?.{0,12}(?:均|都|同样)|(?:内部|内源).{0,20}(?:开源|社区|公开|外部).{0,12}(?:均|都|同样)|(?:开源|社区|公开|外部).{0,20}(?:内部|内源).{0,12}(?:均|都|同样)/i;
const systems: [keyof typeof systemLabels, RegExp][] = [
  ['windows', /\bwindows(?:\s*\d+)?\b|\bwin(?:7|8|10|11|32|64)\b|\bpowershell\b|\bwsl2?\b/i],
  ['macos', /\bmacos\b|\bmac\s+os(?:\s*x)?\b|\bos\s*x\b|\bmacbook\b|\bdarwin\b|\bmac\b(?!\s*(?:address|地址))/i],
  ['other', /\blinux\b|\bubuntu\b|\bdebian\b|\bcentos\b|\bfedora\b|\barch\s+linux\b|\balpine\b|\bfreebsd\b|\bandroid\b|\bios\b|\bharmonyos\b|鸿蒙|其他系统/i],
];
const evidence = (clauses: string[]) => [...new Set(clauses)].slice(0, 4).map(text => text.slice(0, 240));
const clausesIn = (text: string) => text.replace(/<!--[\s\S]*?-->/g, '')
  .split(/\n|[。；;，,!?！？]|\.\s+|但是|但|而|\b(?:but|whereas)\b/i)
  .map(text => text.trim()).filter(text => text && !/^[-*]?\s*\[ \]/.test(text));
const affectedClauses = (clauses: string[]) => clauses.filter(text => !/(?:无|没有|未出现|不会).{0,6}(?:问题|报错|异常|复现)|不受影响|无法复现|未复现|(?<!无法|不能|不)正常|works? (?:fine|correctly)|not affected|cannot reproduce|no (?:issue|error|problem)/i.test(text));

/** Explicit reported environments outrank platform names in background text or examples. */
function systemContext(title: string, body: string) {
  const prose = body.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gm, '');
  const headings = [...prose.matchAll(/^#{1,6}[ \t]+(?:环境|运行环境|复现环境|系统环境|环境信息|操作系统|受影响系统|environment|operating systems?|os)[ \t]*[:：]?[ \t]*\r?$/gim)];
  if (!headings.length) return affectedClauses(clausesIn(`${title}\n${prose}`));
  const declared = affectedClauses(clausesIn(headings.map(match =>
    prose.slice(match.index! + match[0].length).split(/^#{1,6}[ \t]+/m)[0]).join('\n')));
  return declared.some(text => systems.some(([, pattern]) => pattern.test(text)))
    ? declared : affectedClauses(clausesIn(title));
}

/** Conservative content rules, not an inference from repository visibility or author identity. */
export function classifyIssueContext(fact: Pick<IssueSourceFact, 'title' | 'body'>): IssueContextClassification {
  const clauses = clausesIn(`${fact.title}\n${fact.body ?? ''}`);
  const relevant = clauses.filter(text => !/(?:不涉及|未使用|无需|无关|排除|not using|unrelated to|without)\s*[:：]?\s*(?:code[ -]?(?:agent|hub)|内源|内部|开源|社区|公开|外部)/i.test(text));
  const shared = relevant.filter(text => common.test(text));
  const inside = relevant.filter(text => internal.test(text));
  const outside = relevant.filter(text => external.test(text));
  const origin = shared.length ? 'common' : inside.length && !outside.length ? 'internal'
    : outside.length && !inside.length ? 'external' : 'unknown';
  // Successful comparison environments and unselected template choices are not affected systems.
  const affected = systemContext(fact.title, fact.body ?? '');
  const matched = systems.filter(([, pattern]) => affected.some(text => pattern.test(text)));
  return { ruleVersion: 'origin-system-v1', basis: fact.body === undefined ? 'title' : 'description', origin,
    systems: matched.map(([key]) => key), originEvidence: evidence(shared.length ? shared : [...inside, ...outside]),
    systemEvidence: evidence(affected.filter(text => matched.some(([, pattern]) => pattern.test(text)))) };
}

/** A body-backed persisted analysis is usable only for the exact current source stamp. */
export function issueContextFor(fact: IssueSourceFact, result?: IssueClassification, human?: { affectedSystems?: (keyof typeof systemLabels)[] }): IssueContextClassification {
  if (!fact.unavailable && human?.affectedSystems !== undefined) return { ...issueContextFor(fact, result),
    systems: human.affectedSystems, systemsSource: 'human', systemEvidence: ['人工确认的受影响系统'] };
  if (fact.unavailable) return classifyIssueContext({ title: '' });
  if ((fact.body === undefined || result?.context?.systemsSource === 'cat') && result?.context && result.source.issueId === fact.id
    && result.source.number === fact.number && result.source.updatedAt === fact.updatedAt) return result.context;
  return classifyIssueContext(fact);
}

export function contextTags(context: IssueContextClassification): string[] {
  return [ ...(context.origin === 'unknown' ? [] : [`问题来源：${originLabels[context.origin]}`]),
    ...context.systems.map(system => `操作系统：${systemLabels[system]}`) ];
}
