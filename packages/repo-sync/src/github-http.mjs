import { fail } from './config.mjs';
import { checkpoint, execution } from './execution.mjs';
import { githubToken } from './github-auth.mjs';
import { trustSystemCA } from './system-ca.mjs';
export const githubOrigin = 'https://api.github.com';
export function githubUrl(path) {
  let url;
  try {
    url = new URL(path, `${githubOrigin}/`);
  } catch {
    fail('GITHUB_RESPONSE_INVALID', 'GitHub 请求或分页地址无效，已暂停。');
  }
  if (
    url.origin !== githubOrigin ||
    url.username ||
    url.password ||
    url.hash ||
    !/^\/(repos\/[^/]+\/[^/]+(?:\/|$)|graphql$)/.test(url.pathname)
  )
    fail('GITHUB_RESPONSE_INVALID', 'GitHub 请求或分页地址超出来源接口范围，已暂停；不会向其他地址发送凭据。');
  return url;
}
export async function githubRequest(config, path, payload) {
  checkpoint();
  trustSystemCA();
  const url = githubUrl(path),
    token = githubToken(config);
  const timeout = AbortSignal.timeout(30000),
    signal = execution()?.signal;
  let response;
  try {
    response = await fetch(url.href, {
      method: payload ? 'POST' : 'GET',
      redirect: 'error',
      headers: {
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
  } catch (error) {
    checkpoint();
    if (
      ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT'].includes(
        error.cause?.code,
      )
    )
      fail(
        'GITHUB_TLS_UNTRUSTED',
        'Node 未信任 GitHub API 连接的证书链。请配置系统受信任 CA 并重启服务；不要关闭证书校验。',
      );
    fail(
      'GITHUB_API_UNAVAILABLE',
      '无法连接 GitHub API 或请求超时。请在启动服务的环境核对 api.github.com 的网络、代理和证书；Git 的代理配置不会自动应用到 API。原同步记录保留，可重试。',
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    rejectResponse(response);
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      checkpoint();
      size += chunk.byteLength;
      if (size > 8 * 1024 * 1024)
        fail('GITHUB_RESPONSE_LIMIT', 'GitHub API 响应超过读取上限，已暂停；不会采用截断数据。');
      chunks.push(chunk);
    }
  } catch (error) {
    checkpoint();
    if (error.safeToDisplay) throw error;
    fail('GITHUB_API_UNAVAILABLE', 'GitHub API 响应读取中断；原同步记录保留，请恢复连接后重试。');
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('GITHUB_RESPONSE_INVALID', 'GitHub API 未返回有效 JSON；已暂停，未采用响应内容。');
  }
  return { value, headers: response.headers, url };
}
function rejectResponse(response) {
  if (response.status === 401)
    fail(
      'GITHUB_AUTH_REQUIRED',
      'GitHub API 读取认证缺失或已失效。请在当前项目的“GitHub 读取认证”提供 Token；无需安装 gh，Git 代码认证与 API 认证独立。',
    );
  if (
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))
  )
    fail(
      'GITHUB_RATE_LIMITED',
      'GitHub API 请求额度或频率受限。请稍后重试，或提供有效的 GitHub 读取令牌；不会跳过未读取的 PR / Issue。',
    );
  if (response.status === 403)
    fail(
      'GITHUB_ACCESS_DENIED',
      'GitHub API 拒绝读取。请核对令牌对来源仓库的 Pull requests、Issues 和 Contents 读取权限及组织授权；不会跳过受限对象。',
    );
  if (response.status === 404)
    fail(
      'GITHUB_REPOSITORY_UNAVAILABLE',
      'GitHub 仓库或对象不可读取。请核对来源地址及私有仓库读取权限；这不代表代码仓不存在。',
      { httpStatus: 404 },
    );
  fail('GITHUB_API_UNAVAILABLE', `GitHub API 返回 HTTP ${response.status}。请核对网络与服务后重试；原记录保留。`);
}
