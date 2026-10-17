import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fail } from './config.mjs';

const sessions = new Map();
const verified = new Set();
const key = (config) => JSON.stringify([resolve(config.stateDir), config.bindingId ?? null]);
export const apiSettings = (config) =>
  config.issues?.mode === 'gitlab'
    ? config.issues
    : config.pullRequests?.mode === 'gitlab'
      ? config.pullRequests
      : null;
const identity = (settings) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        settings?.apiUrl,
        String(settings?.projectId),
        settings?.tokenEnv,
        settings?.authMode ?? 'environment',
      ]),
    )
    .digest('hex');
function session(config, settings = apiSettings(config)) {
  if (typeof config.stateDir !== 'string') return null;
  const value = sessions.get(key(config));
  return value?.identity === identity(settings) ? value : null;
}
export function issueToken(config, settings = apiSettings(config)) {
  const value = session(config, settings)?.token ?? environmentToken(settings);
  if (!value)
    fail(
      'ISSUE_AUTH_REQUIRED',
      '请在当前项目的 Issue 设置输入 Token；使用环境变量的旧配置也可以继续。服务重启后需重新输入。',
    );
  return value;
}
export function authenticationStatus(config) {
  const direct = Boolean(session(config)),
    environment = Boolean(environmentToken(apiSettings(config)));
  return {
    available: direct || environment,
    source: direct ? 'session' : environment ? 'environment' : 'missing',
    verified: (direct || environment) && verified.has(key(config)),
  };
}
function environmentToken(settings) {
  return settings?.authMode !== 'session' && settings?.tokenEnv ? process.env[settings.tokenEnv] : undefined;
}
export function setIssueToken(config, token, owner) {
  if (!apiSettings(config))
    fail('ISSUE_AUTH_UNSUPPORTED', '当前平台方式没有内置 Token 接口，请先配置 GitLab 兼容 API。');
  if (
    typeof token !== 'string' ||
    token.length > 32768 ||
    [...token].some((c) => c.charCodeAt(0) < 33 || c.charCodeAt(0) > 126)
  )
    fail('INVALID_ISSUE_TOKEN', 'Token 格式无效；请重新输入，不能包含空白或控制字符。');
  verified.delete(key(config));
  if (token) sessions.set(key(config), { token, identity: identity(apiSettings(config)), owner });
  else {
    const value = sessions.get(key(config));
    if (value?.owner === owner) sessions.delete(key(config));
  }
  return authenticationStatus(config);
}
export function markIssueVerified(config) {
  if (authenticationStatus(config).available) verified.add(key(config));
  return authenticationStatus(config);
}
export function clearIssueTokens(owner) {
  for (const [id, value] of sessions) if (value.owner === owner) {
    sessions.delete(id);
    verified.delete(id);
  }
}
export function retainIssueToken(previous, next) {
  const value = session(previous);
  if (!value || identity(apiSettings(previous)) !== identity(apiSettings(next))) return;
  if (
    ['sourceUrl', 'internalUrl', 'internalWebUrl', 'sourceBranch', 'targetBranch'].some(
      (field) => previous[field] !== next[field],
    )
  )
    return;
  sessions.set(key(next), value);
  if (key(previous) !== key(next)) sessions.delete(key(previous));
}
