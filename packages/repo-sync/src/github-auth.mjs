import { resolve } from 'node:path';
import { fail } from './config.mjs';

const sessions = new Map();
const verified = new Set();
const key = (config) => (config?.stateDir ? JSON.stringify([resolve(config.stateDir), config.bindingId]) : null);
const valid = (token) => typeof token === 'string' && token.length <= 32768 && !/[^\x21-\x7e]/.test(token);
const environment = () => process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
export function githubToken(config) {
  const token = sessions.get(key(config))?.token || environment();
  if (!valid(token))
    fail('GITHUB_AUTH_INVALID', 'GitHub 读取令牌格式无效，请在当前项目重新提供；不要在地址中携带凭据。');
  return token;
}
export function requireGithubToken(config) {
  const token = githubToken(config);
  if (!token)
    fail(
      'GITHUB_AUTH_REQUIRED',
      '完整读取 PR 关联 Issue 与关闭事件需要 GitHub API 读取令牌。请在当前项目的“GitHub 读取认证”提供 Token；无需安装或登录 gh。',
    );
  return token;
}
export function githubAuthentication(config) {
  const direct = Boolean(sessions.get(key(config))),
    value = environment();
  return {
    available: direct || Boolean(value && valid(value)),
    source: direct ? 'session' : value && valid(value) ? 'environment' : 'missing',
    verified: (direct || Boolean(value && valid(value))) && verified.has(key(config)),
  };
}
export function setGithubToken(config, token, owner) {
  if (!key(config) || !valid(token))
    fail('GITHUB_AUTH_INVALID', '请在当前项目提供有效的 GitHub 读取令牌；不能包含空白或控制字符。');
  verified.delete(key(config));
  if (token) sessions.set(key(config), { token, owner });
  else if (sessions.get(key(config))?.owner === owner) sessions.delete(key(config));
  return githubAuthentication(config);
}
export function markGithubVerified(config) {
  if (githubAuthentication(config).available) verified.add(key(config));
  return githubAuthentication(config);
}
export function clearGithubTokens(owner) {
  for (const [id, value] of sessions) if (value.owner === owner) {
    sessions.delete(id);
    verified.delete(id);
  }
}
export function retainGithubToken(previous, next) {
  const value = sessions.get(key(previous));
  if (
    !value ||
    ['sourceUrl', 'internalUrl', 'sourceBranch', 'targetBranch'].some((field) => previous[field] !== next[field])
  )
    return;
  sessions.set(key(next), value);
  if (key(previous) !== key(next)) sessions.delete(key(previous));
}
