import { createHash } from 'node:crypto';
import { CliUnavailableError, githubCliAttach, githubCliCanAttach, githubCliToken, runCli } from './cli.js';
import { record, safeUrl, text } from './config.js';
import type { Attachment, Host, Profile, Provider, RemoteIssue, Report } from './types.js';

export const marker = (id: string) => `<!-- clowder-feedback:${id} -->`;
export class FeedbackTokenError extends Error {
  constructor(message: string, readonly code: 'feedback_token_missing' | 'feedback_token_invalid',
    readonly githubCli?: 'unavailable' | 'login' | 'rejected') {
    super(message);
  }
}
type Request = (path: string, signal: AbortSignal, body?: unknown) => Promise<unknown>;
export function provider(host: Host, target: Profile, fetcher: typeof fetch = fetch,
  localGitHubToken = githubCliToken, canAttach = githubCliCanAttach, attach = githubCliAttach): Provider {
  const gitlab = target.provider === 'gitlab';
  const prefix = gitlab ? `/projects/${encodeURIComponent(target.project)}` : `/repos/${target.project}`;
  const githubDotCom = target.provider === 'github' && target.apiBaseUrl === 'https://api.github.com' &&
    new URL(target.issueCreateUrl).origin === 'https://github.com';
  let auth: string | undefined;
  let usingGithubCli = false;
  function accessError(invalid: boolean, cli?: FeedbackTokenError['githubCli']) {
    return new FeedbackTokenError(
      invalid ? '目标平台未接受当前凭据，请更换后再试。' : '配置目标的访问令牌后即可检查自动提交。',
      invalid ? 'feedback_token_invalid' : 'feedback_token_missing', cli);
  }
  async function useGithubCli(signal: AbortSignal, invalid: boolean) {
    if (!githubDotCom) throw accessError(invalid);
    const credential = await localGitHubToken(signal).catch(error => {
      signal.throwIfAborted();
      throw accessError(invalid, error instanceof CliUnavailableError ? 'unavailable' : 'login');
    });
    if (!credential) throw accessError(invalid, 'login');
    auth = credential;
    usingGithubCli = true;
    return credential;
  }
  async function token(signal: AbortSignal): Promise<string> {
    if (auth) return auth;
    auth = await host.secrets.get(target.tokenRef);
    return auth || useGithubCli(signal, false);
  }
  const request: Request = async (path, signal, body) => {
    const send = async (auth: string) => fetcher(`${target.apiBaseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'error',
      headers: { ...(gitlab ? { 'PRIVATE-TOKEN': auth } : { authorization: `Bearer ${auth}`, accept: 'application/vnd.github+json' }),
        ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
    });
    let response = await send(await token(signal));
    // Only retry the read-only identity probe. A create must never be replayed with another credential.
    if (response.status === 401 && path === '/user' && githubDotCom && !usingGithubCli) {
      await response.body?.cancel();
      response = await send(await useGithubCli(signal, true));
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw accessError(true, usingGithubCli ? 'rejected' : undefined);
      throw new Error(`目标平台返回 HTTP ${response.status}`);
    }
    const data = await boundedBody(response, 2_000_000);
    return JSON.parse(data.toString('utf8')) as unknown;
  };
  const cli = async (op: string, payload: unknown, signal: AbortSignal) => {
    if (!target.command) throw new Error('未配置组织 CLI');
    return runCli(target.command, { protocol: 'clowder-feedback/v1', op, target: publicTarget(target), payload }, signal);
  };
  const parseIssue = (raw: unknown): RemoteIssue => {
    const value = record(raw);
    const id = String(value.iid ?? value.number ?? value.id ?? '');
    if (!/^\d+$/.test(id)) throw new Error('平台未返回 Issue 编号，必须先核对远端状态');
    const url = safeUrl(value.web_url ?? value.html_url ?? value.url);
    const page = new URL(target.issueCreateUrl); const actual = new URL(url);
    if (actual.origin !== page.origin || !actual.pathname.startsWith(`/${target.project}/`) || !new RegExp(`/issues/${id}$`).test(actual.pathname)) {
      throw new Error('平台返回了与目标不匹配的 Issue 地址');
    }
    return { id, url, title: text(value.title, 500), body: text(value.description ?? value.body, 120_000) };
  };
  return {
    async preflight(signal, hasPictures) {
      if (target.mode === 'manual') throw new Error('此目标仅支持手动创建');
      if (target.provider === 'organization-cli') {
        const value = record(await cli('preflight', {}, signal));
        if (value.project !== target.project || value.canCreate !== true || !value.principal || value.visibility !== target.visibility) throw new Error('CLI 身份、项目或可见性核验失败');
        return { principal: text(value.principal, 100), visibility: String(value.visibility), attachments: value.attachments === true };
      }
      const user = record(await request('/user', signal));
      const project = record(await request(prefix, signal));
      const actualProject = project.path_with_namespace ?? project.full_name;
      const visibility = gitlab ? project.visibility === 'public' ? 'public' : 'private' : project.private ? 'private' : 'public';
      if (actualProject !== target.project || visibility !== target.visibility || project.archived || project.has_issues === false || project.issues_enabled === false) throw new Error('项目身份、可见性或 Issue 功能核验失败');
      const attachments = gitlab || Boolean(target.attachmentCommand);
      const githubAuth = githubDotCom ? (usingGithubCli ? 'cli' : 'token') : undefined;
      const checkGitHubAttachments = hasPictures && !attachments && githubDotCom;
      const canPush = checkGitHubAttachments && project.permissions && record(project.permissions).push === true;
      const githubCliAttachments = canPush && await canAttach(signal);
      return { principal: text(user.login ?? user.username, 100), visibility, attachments, githubAuth,
        ...(githubCliAttachments ? {githubCliAttachments:true} :
          checkGitHubAttachments ? {githubAttachmentLimit:canPush ? 'cli' : 'permission'} : {}) };
    },
    async attachToIssue(issue, pictures, id, signal) {
      if (!githubDotCom) throw new Error('GitHub CLI 仅用于 GitHub.com');
      const comment = await attach(issue.url, pictures, `截图\n\n${marker(id)}`, await token(signal), signal);
      const url = new URL(comment);
      const expected = new URL(issue.url);
      const match = /^#issuecomment-(\d+)$/.exec(url.hash);
      if (url.origin !== expected.origin || url.pathname !== expected.pathname || !match) throw new Error('截图评论地址无法核验');
      const remote = record(await request(`${prefix}/issues/comments/${match[1]}`, signal));
      const body = text(remote.body, 120_000);
      if (remote.html_url !== url.href || !body.includes(marker(id)) || !pictures.every((_, i) =>
        body.includes(`![Clowder-screenshot-${i + 1}](https://`))) {
        throw new Error('截图评论未完整回读');
      }
    },
    async upload(attachment, id, signal) {
      // Original downloads are local-only. CLI transports receive exactly the approved send copy.
      attachment = { id: attachment.id, name: attachment.name, mime: attachment.mime, base64: attachment.base64, sha256: attachment.sha256 };
      let url: string;
      if (target.provider === 'organization-cli' || target.attachmentCommand) {
        const result = target.attachmentCommand
          ? await runCli(target.attachmentCommand, { protocol: 'clowder-feedback/v1', op: 'upload', target: publicTarget(target), payload: { submissionId: id, attachment } }, signal)
          : await cli('upload', { submissionId: id, attachment }, signal);
        const value = record(result);
        if (value.sha256 !== attachment.sha256 || value.visibility !== target.visibility) throw new Error('附件回执与已确认图片不匹配');
        url = safeUrl(value.url);
        if (!target.attachmentOrigins.includes(new URL(url).origin)) throw new Error('附件源未被目标配置允许');
        const response = await fetcher(url, { signal, redirect: 'error' });
        if (!response.ok || createHash('sha256').update(await boundedBody(response, 4_000_000)).digest('hex') !== attachment.sha256) throw new Error('附件远端字节回读失败');
      } else {
        if (!gitlab) throw new Error('该目标尚未配置附件上传通路');
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(Buffer.from(attachment.base64, 'base64'))], { type: attachment.mime }), attachment.name);
        const value = record(await request(`${prefix}/uploads`, signal, form));
        const fullPath = text(value.full_path, 2048);
        url = safeUrl(new URL(fullPath, new URL(target.issueCreateUrl).origin).href);
        if (new URL(url).origin !== new URL(target.issueCreateUrl).origin || !new URL(url).pathname.startsWith(`/${target.project}/uploads/`)) throw new Error('附件路径与目标项目不匹配');
        const response = await fetcher(url, { signal, redirect: 'error', headers: { 'PRIVATE-TOKEN': await token(signal) } });
        if (!response.ok || createHash('sha256').update(await boundedBody(response, 4_000_000)).digest('hex') !== attachment.sha256) throw new Error('附件远端字节回读失败');
      }
      return `![${attachment.name}](${url})`;
    },
    async create(report: Report, id, signal) {
      const body = `${report.body}\n\n${marker(id)}`;
      return parseIssue(target.provider === 'organization-cli'
        ? await cli('create', { submissionId: id, title: report.title, body }, signal)
        : await request(`${prefix}/issues`, signal, { title: report.title, ...(gitlab ? { description: body } : { body }) }));
    },
    async reconcile(id, signal) {
      const raw = target.provider === 'organization-cli' ? await cli('reconcile', { submissionId: id }, signal)
        : await request(`${prefix}/issues?${gitlab ? 'scope=all&order_by=created_at&sort=desc' : 'state=all&sort=created&direction=desc'}&per_page=100`, signal);
      const candidates = Array.isArray(raw) ? raw : record(raw).issues;
      if (!Array.isArray(candidates)) throw new Error('核对返回格式无效');
      const found = candidates.filter(v => { const p = record(v); return String(p.description ?? p.body ?? '').includes(marker(id)); });
      if (found.length !== 1) return;
      return parseIssue(found[0]);
    },
    async read(issue, signal) {
      return parseIssue(target.provider === 'organization-cli' ? await cli('read', { id: issue.id }, signal) : await request(`${prefix}/issues/${issue.id}`, signal));
    },
  };
}
export function publicTarget(target: Profile) { return { id: target.id, project: target.project, apiBaseUrl: target.apiBaseUrl, visibility: target.visibility }; }
async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new Error('远端响应为空');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > limit) throw new Error('远端响应超限'); chunks.push(next.value); } }
  finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
