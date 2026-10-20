import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import packageInfo from '../package.json' with { type: 'json' };
import { dispatch } from './actions.mjs';
import { fail } from './config.mjs';
import { safeError } from './execution.mjs';
import { clearGithubTokens, githubAuthentication } from './github-auth.mjs';
import { githubAuthRequest } from './github-auth-http.mjs';
import { body, requestPath, requireToken, send } from './http.mjs';
import { publicIssues } from './issue-adapter.mjs';
import { clearIssueTokens } from './issue-auth.mjs';
import { issueAuthRequest } from './issue-auth-http.mjs';
import { journeyProgress } from './journey-progress.mjs';
import { publicApi, publicPlatform } from './pr-settings.mjs';
import { projectSettingsRequest } from './project-settings-http.mjs';
import { recordDetail, recordList } from './records.mjs';
import { roundProgress } from './round-progress.mjs';
import { checkProjectInput, projectRequest, serverScopes } from './server-projects.mjs';
import { configure } from './settings.mjs';
import { transferRequest } from './transfer-http.mjs';
import { transferState } from './transfer-state.mjs';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '../web');
const assets = new Map([
  ['/', 'index.html'],
  ['/app.mjs', 'app.mjs'],
  ['/styles.css', 'styles.css'],
  ['/progress.mjs', 'progress.mjs'],
  ['/receipts.mjs', 'receipts.mjs'],
  ['/version.mjs', 'version.mjs'],
  ['/connections.mjs', 'connections.mjs'],
  ['/operations.mjs', 'operations.mjs'],
  ['/operation-view.mjs', 'operation-view.mjs'],
  ['/files.mjs', 'files.mjs'],
  ['/pr.mjs', 'pr.mjs'],
  ['/diagnostics.mjs', 'diagnostics.mjs'],
  ['/issues.mjs', 'issues.mjs'],
  ['/platform.mjs', 'platform.mjs'],
  ...[
    'ui.mjs',
    'history.mjs',
    'workflow.mjs',
    'delivery-overview.mjs',
    'candidate-recovery.mjs',
    'delivery-overview.css',
    'app-shell.mjs',
    'app-shell.css',
    'workbench.mjs',
    'action-policy.mjs',
    'stage-facts.mjs',
    'attempts.mjs',
    'actionbar.mjs',
    'journey.css',
    'source-target.mjs',
    'issue-settings.mjs',
    'issue-reference-notes.mjs',
    'projects.mjs',
    'projects.css',
    'project-scope.mjs',
    'project-view.mjs',
    'repository-fields.mjs',
    'closure-settings.mjs',
    'issue-auth.mjs',
    'form-errors.mjs',
    'issue-inference.mjs',
    'connection.css',
    'file-rules.mjs',
    'file-rule-fields.mjs',
    'file-rule-selection.mjs',
    'file-rules.css',
    'setup-navigation.mjs',
    'github-auth.mjs',
    'commit-settings.mjs',
    'automation-view.mjs',
    'expansion.mjs',
    'setup-view.mjs',
    'setup-flow.mjs',
    'form-submission.mjs',
    'view-state.mjs',
    'preview-view.mjs',
    'error-guide.mjs',
    'operator-journey.css',
    'task-progress.mjs',
    'step-plan.mjs',
    'workflow-plan.mjs',
    'settings-view.mjs',
    'settings-controller.mjs',
    'workbench-layout.css',
    'workbench-viewport.css',
    'round-view.mjs',
    'round-controller.mjs',
    'panorama.mjs',
    'panorama.css',
    'round.css',
    'records.css',
    'v3-workbench.css',
    'v3-hero.mjs',
    'flow-stage.mjs',
    'live-workflow.mjs',
    'continuation-view.mjs',
    'action-scope.mjs',
    'transfer-view.mjs',
    'transfers.mjs',
    'transfers.css',
    'recovery-navigation.mjs',
  ].map((file) => [`/${file}`, file]),
]);
export function createReceiverServer(receiver, options = {}) {
  const token = randomBytes(32).toString('hex');
  options = {
    ...options,
    runtime: {
      productVersion: packageInfo.version,
      apiVersion: 2,
      instanceId: randomBytes(12).toString('hex'),
      startedAt: new Date().toISOString(),
    },
  };
  const scopes = serverScopes(receiver, options);
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
    );
    try {
      const path = requestPath(request, server.address()?.port);
      if (!path.startsWith('/api/'))
        return request.method === 'GET'
          ? get(receiver, options, token, path, response, request.url)
          : send(response, 404, { code: 'NOT_FOUND' });
      if (await projectRequest(request, response, options, token, path)) return;
      const context = await scopes.scope(request.url);
      if (await privateRequest(request, response, path, context, token, options.runtime.instanceId)) return;
      if (request.method === 'GET')
        return await get(context.receiver, context.options, token, path, response, request.url);
      await executionRequest(request, response, path, context, scopes, token);
    } catch (error) {
      return sendError(response, error);
    }
  });
  server.shutdown = async () => {
    await scopes.close();
    clearIssueTokens(options.runtime.instanceId);
    clearGithubTokens(options.runtime.instanceId);
    if (server.listening) await new Promise((done) => server.close(done));
  };
  return server;
}
async function executionRequest(request, response, path, context, scopes, token) {
  if (request.method !== 'POST' || path !== '/api/action') return send(response, 404, { code: 'NOT_FOUND' });
  requireToken(request, token);
  const input = await body(request);
  checkProjectInput(input, context.options.projectId);
  if (context.tasks.busy())
    fail('OPERATION_RUNNING', '此项目已有任务执行中，请处理原任务；可切换或新增其他项目');
  scopes.update(await post(context.receiver, context.options, token, input, response));
}
async function taskRequest(request, response, path, tasks, projectId) {
  if (request.method === 'POST' && path === '/api/tasks') {
    const input = await body(request);
    checkProjectInput(input, projectId);
    return send(response, 202, { operation: await tasks.start(input) });
  }
  const match = /^\/api\/tasks\/([a-f0-9]{32})(\/cancel|\/persist)?$/.exec(path);
  if (!match) return send(response, 404, { code: 'NOT_FOUND' });
  if (request.method === 'POST' && match[2]) {
    checkProjectInput(await body(request), projectId);
    return send(response, 202, {
      operation: await (match[2] === '/persist' ? tasks.retryPersistence(match[1]) : tasks.cancel(match[1])),
    });
  }
  if (request.method !== 'GET' || match[2]) return send(response, 404, { code: 'NOT_FOUND' });
  const operation = await tasks.latest(match[1]);
  return send(
    response,
    operation ? 200 : 404,
    operation
      ? { operation }
      : {
          code: 'TASK_NOT_FOUND',
          message: '尚未找到这笔任务，请继续查询原请求',
        },
  );
}
async function post(receiver, options, token, input, response) {
  let result;
  if (options.connection) {
    result = await options.connection.run(input, options);
    receiver = await options.connection.current();
  } else if (input.action === 'configure') receiver = await configure(receiver, input);
  else result = await dispatch(receiver, input, options);
  if (
    [
      'configure',
      'configure-repositories',
      'configure-file-rules',
      'configure-pr',
      'configure-issues',
      'configure-closure',
      'configure-identity',
    ].includes(input.action)
  )
    await get(receiver, options, token, '/api/status', response);
  else
    send(response, 200, {
      result: ['heads', 'tags', 'baseline-file', 'inspect-baseline', 'preview-sync'].includes(input.action)
        ? result
        : null,
      state: await receiver.status(),
    });
  return receiver;
}
function sendError(response, error) {
  const status = ['HOST_REJECTED', 'ORIGIN_REJECTED', 'TOKEN_REJECTED'].includes(error.code)
    ? 403
    : error.code === 'BODY_TOO_LARGE'
      ? 413
      : 409;
  return send(response, status, safeError(error));
}
async function get(receiver, options, token, path, response, url = '') {
  if (assets.has(path)) {
    const file = assets.get(path);
    const type = file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    response.setHeader('Content-Type', `${type}; charset=utf-8`);
    response.end(await readFile(resolve(web, file)));
    return;
  }
  if (path !== '/api/status') return send(response, 404, { code: 'NOT_FOUND' });
  const {
    sourceUrl,
    internalUrl,
    internalWebUrl,
    sourceBranch,
    targetBranch,
    mode,
    internalPaths,
    mergePaths,
    checkProfile,
    commitClosureVerified,
    bindingId,
  } = receiver?.config ?? {};
  const state = receiver ? await receiver.status() : null;
  const compact = new URL(url || '/', 'http://localhost').searchParams.get('compact') === '1';
  return send(response, 200, {
    token,
    transfer: await transferState(receiver?.config),
    sourceAuthentication: githubAuthentication(receiver?.config),
    journeyProgress: journeyProgress(state),
    state:
      state && compact
        ? {
            ...state,
            deliveries: state.active ? [state.active] : [],
            events: [],
            deliveryCount: state.deliveries.length,
          }
        : state,
    config: receiver
      ? {
          commitStrategy: receiver.config.commitStrategy,
          receivingIdentity: receiver.config.receivingIdentity,
          autoMergeWaitMs: receiver.config.autoMergeWaitMs,
          sourceUrl,
          internalUrl,
          internalWebUrl,
          prMode: publicPlatform(receiver).prMode,
          prTransport: publicPlatform(receiver).transport,
          sourceBranch,
          targetBranch,
          mode,
          internalPaths,
          mergePaths,
          checkProfile,
          commitClosureVerified,
          bindingId,
          issueAutomation: publicIssues(receiver.config),
          platformApi: publicApi(receiver.config),
        }
      : null,
    connection: options.connection?.describe(),
    ...(await workspaceSnapshot(options)),
    platform: publicPlatform(receiver),
    service: 'production',
    runtime: options.runtime,
    observation: options.observation?.(),
    operation: await options.tasks.latest(),
  });
}
export function listen(server, port = 5187) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || [3003, 3004].includes(port))
    throw new Error('本地工具端口无效或被 Clowder AI 保留');
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolvePromise(server));
  });
}

async function recordRequest(request, response, receiver, tasks, token, path) {
  if (path === '/api/round') {
    requireToken(request, token);
    if (request.method !== 'GET') { send(response, 404, { code: 'NOT_FOUND' }); return true; }
    const params = new URL(request.url, 'http://localhost').searchParams;
    params.delete('project');
    send(response, 200, { round: roundProgress(await receiver?.status(), params) });
    return true;
  }
  if (path === '/api/records' || /^\/api\/records\/[a-f0-9]{24}$/.test(path)) {
    requireToken(request, token);
    if (request.method !== 'GET') {
      send(response, 404, { code: 'NOT_FOUND' });
      return true;
    }
    const params = new URL(request.url, 'http://localhost').searchParams;
    params.delete('project');
    send(
      response,
      200,
      path === '/api/records'
        ? await recordList(receiver, params)
        : await recordDetail(receiver, path.split('/').at(-1), params, tasks),
    );
    return true;
  }
  return false;
}

async function workspaceSnapshot(options) {
  return options.workspace ? { workspace: await options.workspace() } : {};
}

async function privateRequest(request, response, path, context, token, owner) {
  const { tasks } = context;
  if (await projectSettingsRequest(request, response, path, context, token, owner)) return true;
  if (await transferRequest(request, response, path, context, token)) return true;
  if (await githubAuthRequest(request, response, path, context, token, owner)) return true;
  if (await issueAuthRequest(request, response, path, context, token, owner)) return true;
  if (await recordRequest(request, response, context.receiver, tasks, token, path)) return true;
  if (path.startsWith('/api/tasks')) {
    requireToken(request, token);
    await taskRequest(request, response, path, tasks, context.options.projectId);
    return true;
  }
  return false;
}
