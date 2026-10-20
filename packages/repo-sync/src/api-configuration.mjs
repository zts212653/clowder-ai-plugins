import { configurationErrors } from './configuration-errors.mjs';

export function validateGitlabApi(config, value) {
  const errors = [];
  let url, project;
  try {
    if (typeof value.apiUrl !== 'string') throw new Error();
    url = new URL(value.apiUrl.trim());
  } catch {
    errors.push(['issueApiUrl', 'url']);
  }
  if (url) {
    const reason = apiProblem(config, url);
    if (reason) errors.push(['issueApiUrl', reason]);
  }
  try {
    project = projectPath(value.projectId);
  } catch {
    errors.push(['issueProjectId', 'path']);
  }
  if (value.authMode !== undefined && !['session', 'environment'].includes(value.authMode))
    errors.push(['issueAuthMode', 'mode']);
  else if (value.authMode !== 'session' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.tokenEnv ?? ''))
    errors.push(['issueTokenEnv', 'name']);
  if (errors.length) configurationErrors(errors);
  value.apiUrl = value.apiUrl.trim().replace(/\/+$/, '');
  value.projectId = typeof value.projectId === 'number' ? value.projectId : project;
}
function projectPath(value) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error();
  const project = decodeURIComponent(String(value).trim());
  if (!/^[\w./-]+$/.test(project) || project.split('/').some((part) => ['', '.', '..'].includes(part)))
    throw new Error();
  return project;
}
function apiProblem(config, url) {
  const local = config.allowLocal && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (!local && url.protocol !== 'https:') return 'https';
  if (url.username || url.password || url.href.includes('?') || url.href.includes('#')) return 'credentials';
  return url.pathname.replace(/\/+$/, '').endsWith('/api/v4') ? null : 'root';
}
