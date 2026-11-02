import { createHash } from 'node:crypto';
import type { Command, Host, Profile } from './types.js';

export const defaultProfiles: Profile[] = [{
  id: 'clowder', label: 'Clowder AI · GitHub', revision: 1, provider: 'github', mode: 'both',
  project: 'zts212653/clowder-ai', apiBaseUrl: 'https://api.github.com',
  issueCreateUrl: 'https://github.com/zts212653/clowder-ai/issues/new', visibility: 'public',
  tokenRef: 'githubToken', attachmentOrigins: [],
}];
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的请求对象');
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 100_000): string {
  if (typeof value !== 'string' || value.length > max) throw new Error('文本长度或格式无效');
  return value;
}
export function safeUrl(value: unknown): string {
  const url = new URL(text(value, 2048));
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('目标必须使用不含认证信息和查询参数的 HTTPS 地址');
  }
  return url.href.replace(/\/$/, '');
}
function command(value: unknown): Command | undefined {
  if (value === undefined) return;
  const item = record(value);
  const executable = text(item.executable, 512);
  if (!executable || /[\r\n]/.test(executable) || !Array.isArray(item.args) || item.args.length > 32) throw new Error('CLI 配置无效');
  return { executable, args: item.args.map(v => text(v, 1024)) };
}
export function parseProfiles(raw: unknown): Profile[] {
  if (raw === undefined || raw === '') return structuredClone(defaultProfiles);
  const values: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(values) || !values.length || values.length > 10) throw new Error('需要 1 至 10 个反馈目标');
  const profiles = values.map(value => {
    const p = record(value);
    if (!['github', 'gitlab', 'organization-cli'].includes(String(p.provider))) throw new Error('未知反馈适配器');
    const project = text(p.project, 256);
    if (!/^[\w.-]+(?:\/[\w.-]+)+$/.test(project)) throw new Error('项目必须使用 namespace/repository 格式');
    if (!['manual', 'both'].includes(String(p.mode)) || !['public', 'private', 'unknown'].includes(String(p.visibility))) throw new Error('提交模式或可见性无效');
    const apiBaseUrl = safeUrl(p.apiBaseUrl);
    const issueCreateUrl = safeUrl(p.issueCreateUrl);
    const page = new URL(issueCreateUrl);
    if (!page.pathname.includes(`/${project}/`) || !/\/issues\/new$|\/-\/issues\/new$/.test(page.pathname)) throw new Error('手动创建地址与项目不匹配');
    if (p.provider === 'github' && new URL(apiBaseUrl).hostname === 'api.github.com' && page.hostname !== 'github.com') throw new Error('GitHub 目标不匹配');
    if (p.provider === 'gitlab' && new URL(apiBaseUrl).origin !== page.origin) throw new Error('GitLab 目标不匹配');
    const result: Profile = {
      id: text(p.id, 80), label: text(p.label, 100), revision: Number(p.revision),
      provider: p.provider as Profile['provider'], mode: p.mode as Profile['mode'], project, apiBaseUrl, issueCreateUrl,
      visibility: p.visibility as Profile['visibility'], tokenRef: p.provider === 'gitlab' ? 'gitlabToken' : 'githubToken',
      command: command(p.command), attachmentCommand: command(p.attachmentCommand),
      attachmentOrigins: Array.isArray(p.attachmentOrigins) ? p.attachmentOrigins.map(safeUrl) : [],
    };
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(result.id) || !Number.isSafeInteger(result.revision) || result.revision < 1) throw new Error('目标 ID 或版本无效');
    if (result.provider === 'organization-cli' && result.mode === 'both' && !result.command) throw new Error('需要配置组织 CLI');
    return result;
  });
  if (new Set(profiles.map(p => p.id)).size !== profiles.length) throw new Error('目标 ID 不能重复');
  return profiles;
}
export async function profiles(host: Host): Promise<Profile[]> { return parseProfiles(await host.config.get('destinations')); }
export function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function feedbackTitle(kind: 'bug' | 'feat', title: string, body = '') {
  const summary = title.replace(/^(?:(?:bug|feat):\s*)+/i, '').trim() || body.trim().split('\n')[0] || '反馈';
  return `${kind}: ${summary.slice(0, 194)}`;
}
export const feedbackKey = (userId: string, id: string) => `feedback:${digest(userId)}:${id}`;
export const analysisKey = (userId: string, id?: string) => `analysis:${digest(userId)}${id ? `:${id}` : ''}`;
