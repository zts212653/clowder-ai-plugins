import { dirname, join } from 'node:path';
import { dispatch } from './actions.mjs';
import { fail, validateConfig } from './config.mjs';
import { githubRepository } from './github.mjs';
import { retainGithubToken } from './github-auth.mjs';
import { retainIssueToken } from './issue-auth.mjs';
import {
  checkIssueSettings,
  issueConfiguration,
  issueInputKeys,
  repositoryWebFromIssue,
} from './issue-settings.mjs';
import { checkFrozenPr, checkPlatformInput, prConfiguration } from './pr-settings.mjs';
import { configurationLock, privateLocation, readPrivate, writePrivate } from './private-config.mjs';
import { projectConfiguration } from './project-settings.mjs';
import { recordDelivery } from './recording.mjs';
import { configuredReceiver } from './settings.mjs';
import { assertTransferWritable } from './transfer-state.mjs';

const allowed = new Set([
  ...issueInputKeys,
  'action',
  'mode',
  'sourceUrl',
  'internalUrl',
  'sourceBranch',
  'targetBranch',
  'internalPaths',
  'mergePaths',
  'commitClosureVerified',
  'expectedRevision',
  'internalWebUrl',
  'prMode',
  'commitStrategy',
  'receivingIdentity',
]);
export async function createConnection(file, options = {}) {
  const path = await privateLocation(file);
  let revision = null;
  let receiver = null;
  let loaded = false;
  let editable = true;
  async function current() {
    await privateLocation(path);
    const saved = await readPrivate(path);
    if (!loaded || saved.revision !== revision) {
      receiver = saved.config ? await configuredReceiver(saved.config) : null;
      revision = saved.revision;
      loaded = true;
    }
    editable =
      !receiver || (receiver.config.configurationSource === 'workbench' && !(await receiver.status()));
    return receiver;
  }
  async function save(input) {
    if (!input || Object.keys(input).some((key) => !allowed.has(key)))
      fail('INVALID_CONFIGURATION_INPUT', '网页只接受仓库、分支、模式与文件规则，不能提交执行命令或目录');
    await current();
    await assertTransferWritable(receiver?.config);
    if (input.expectedRevision !== revision)
      fail('CONFIGURATION_CHANGED', '配置已变化，请刷新后重新核对，未覆盖原配置');
    if (!editable)
      fail(
        'CONFIGURATION_READ_ONLY',
        '已登记基线或使用手工配置，不能在向导覆盖；另一套绑定请使用新的私有配置文件',
      );
    const previous = receiver?.config;
    const next = repositoryConfiguration(previous, input, path);
    next.stateDir = stateDirectory(path, next.bindingId, options);
    githubRepository(next.sourceUrl);
    const candidate = await configuredReceiver(next);
    if (await candidate.status()) fail('ALREADY_ADOPTED', '此绑定已有台账，请使用原配置继续，不能覆盖');
    if ((await readPrivate(path)).revision !== revision)
      fail('CONFIGURATION_CHANGED', '配置已被本地修改，请刷新核对');
    await writePrivate(path, next);
    loaded = false;
    const configured = await current();
    if (previous) retainGithubToken(previous, configured.config);
    return configured;
  }
  await current();
  async function savePlatform(input) {
    await current();
    checkPlatformInput(input, receiver, revision);
    const next = validateConfig({
      ...receiver.config,
      internalWebUrl: input.internalWebUrl,
      pullRequests: prConfiguration(
        { ...receiver.config, internalWebUrl: input.internalWebUrl },
        input.prMode,
        input,
      ),
    });
    const existing = await receiver.status();
    checkIssueSettings(existing, receiver.config, next);
    const active = existing?.active;
    checkFrozenPr(active, receiver.config, next, existing);
    await writePrivate(path, next);
    loaded = false;
    const configured = await current();
    if (active)
      await configured.store.locked(async () => {
        const state = await configured.read();
        const pending = configured.active(state);
        if (pending) {
          recordDelivery(pending, configured.config, 'configuration', state.issues);
          await configured.store.save(state);
        }
      });
    return configured;
  }
  const editors = new Map([
    ['configure-repositories', save],
    ['configure-file-rules', saveFileRules],
    ['configure-pr', savePlatform],
    ['configure-issues', saveIssues],
    ['configure-closure', saveClosure],
    ['configure-identity', saveIdentity],
    ['configure-project-settings', saveProjectSettings],
  ]);
  return {
    current,
    describe: () => ({
      editable,
      revision,
      managed: receiver?.config.configurationSource === 'workbench',
      configurationFile: path,
      stateDir: receiver?.config.stateDir,
    }),
    save: (input) => configurationLock(path, () => save(input)),
    run: (input, options = {}) =>
      configurationLock(path, async () => {
        await assertTransferWritable((await current())?.config);
        const editor = editors.get(input.action);
        if (editor) return editor(input);
        const bound = await current();
        if (!bound) fail('CONFIGURATION_REQUIRED', '请先保存真实仓库配置，再登记已有基线');
        verifyExecutionInput(input, bound, revision);
        if (input.action === 'configure')
          fail('CONFIGURATION_READ_ONLY', '请在仓库连接向导统一修改模式与文件规则');
        return dispatch(bound, input, options);
      }),
  };
  async function saveFileRules(input) {
    if (
      Object.keys(input).some(
        (key) => !['action', 'expectedRevision', 'expectedBinding', 'internalPaths'].includes(key),
      )
    )
      fail('INVALID_CONFIGURATION_INPUT', '文件树只接受内部保留路径，不能修改仓库或执行命令');
    await current();
    if (
      !receiver ||
      input.expectedRevision !== revision ||
      input.expectedBinding !== receiver.config.bindingId
    )
      fail('CONFIGURATION_CHANGED', '仓库或配置已变化，请刷新后重新核对文件差异，未覆盖原配置');
    if (!editable)
      fail('CONFIGURATION_READ_ONLY', '已启用或由本地文件管理的绑定不能从文件树修改规则，原配置与台账保留');
    const previous = receiver.config;
    const next = validateConfig({
      ...previous,
      internalPaths: input.internalPaths,
      mergePaths: [],
    });
    next.stateDir = stateDirectory(path, next.bindingId, options);
    const candidate = await configuredReceiver(next);
    if (await candidate.status()) fail('ALREADY_ADOPTED', '所选规则已有台账，请使用原配置继续，不能覆盖');
    if ((await readPrivate(path)).revision !== revision)
      fail('CONFIGURATION_CHANGED', '私有配置已被修改，请刷新核对');
    await writePrivate(path, next);
    loaded = false;
    const configured = await current();
    retainIssueToken(previous, configured.config);
    retainGithubToken(previous, configured.config);
    return configured;
  }
  async function saveIssues(input) {
    await current();
    if (
      !receiver ||
      input.expectedRevision !== revision ||
      Object.keys(input).some((key) => !['action', 'expectedRevision', ...issueInputKeys].includes(key))
    )
      fail('CONFIGURATION_CHANGED', 'Issue 设置参数无效或配置已变化，请刷新；网页不能提交命令或凭据');
    const next = validateConfig({
      ...receiver.config,
      issues: issueConfiguration(receiver.config, input),
    });
    const state = await receiver.status();
    checkIssueSettings(state, receiver.config, next);
    await writePrivate(path, next);
    loaded = false;
    const configured = await current();
    if (state?.active)
      await configured.store.locked(async () => {
        const saved = await configured.read();
        recordDelivery(configured.requireActive(saved), configured.config, 'configuration', saved.issues);
        await configured.store.save(saved);
      });
    return configured;
  }
  async function saveIdentity(input) {
    await current();
    if (
      !receiver ||
      input.expectedRevision !== revision ||
      Object.keys(input).some(
        (key) => !['action', 'expectedRevision', 'commitStrategy', 'receivingIdentity'].includes(key),
      )
    )
      fail('CONFIGURATION_CHANGED', '提交身份配置已变化，请刷新后重新核对。');
    const state = await receiver.status();
    if (state?.active || ['RUNNING', 'WAITING_REVIEW'].includes(state?.automation?.status))
      fail('COMMIT_POLICY_FROZEN', '当前交付的提交身份已冻结，请先恢复并完成原同步。');
    const previous = receiver.config;
    await writePrivate(
      path,
      validateConfig({
        ...previous,
        commitStrategy: input.commitStrategy,
        receivingIdentity: input.receivingIdentity,
      }),
    );
    loaded = false;
    const configured = await current();
    retainGithubToken(previous, configured.config);
    retainIssueToken(previous, configured.config);
    return configured;
  }
  async function saveProjectSettings(input) {
    await current();
    if (
      !receiver ||
      input.expectedRevision !== revision ||
      input.expectedBinding !== receiver.config.bindingId
    )
      fail('CONFIGURATION_CHANGED', '项目或配置已变化，请刷新后重新核对，未保存陈旧设置');
    const previous = receiver.config;
    const state = await receiver.status();
    const next = projectConfiguration(previous, state, input);
    await writePrivate(path, next);
    loaded = false;
    const configured = await current();
    retainGithubToken(previous, configured.config);
    retainIssueToken(previous, configured.config);
    return configured;
  }
  async function saveClosure(input) {
    await current();
    if (
      !receiver ||
      receiver.config.mode !== 'continuous' ||
      input.expectedRevision !== revision ||
      input.confirmed !== true ||
      Object.keys(input).some((key) => !['action', 'expectedRevision', 'confirmed'].includes(key))
    )
      fail(
        'CLOSURE_CONFIRMATION_REQUIRED',
        '请在当前项目读完关单规则说明并明确确认，配置变化时需刷新重核对。',
      );
    const next = validateConfig({
      ...receiver.config,
      commitClosureVerified: true,
    });
    await writePrivate(path, next);
    loaded = false;
    const configured = await current();
    await configured.store.locked(async () => {
      const state = await configured.read();
      const active = state && configured.active(state);
      if (active) {
        recordDelivery(active, configured.config, 'configuration', state.issues);
        await configured.store.save(state);
      }
    });
    return configured;
  }
}
function verifyExecutionInput(input, bound, revision) {
  if (input.expectedBinding && input.expectedBinding !== bound.config.bindingId)
    fail('CONFIGURATION_CHANGED', '仓库绑定已变化，任务尚未开始 Git 操作；请刷新核对');
  if (input.expectedRevision !== undefined && input.expectedRevision !== revision)
    fail('CONFIGURATION_CHANGED', '私有配置已变化，任务尚未开始 Git 操作；请刷新核对');
}

function stateDirectory(path, bindingId, options) {
  return options.stateDirectory
    ? options.stateDirectory(bindingId)
    : join(dirname(path), 'bindings', bindingId.slice(0, 24));
}

function repositoryConfiguration(previous = {}, input, path) {
  input = {
    ...input,
    internalWebUrl: input.internalWebUrl || repositoryWebFromIssue(input.issuePageUrl),
  };
  return validateConfig({
    ...(previous ?? {}),
    configurationSource: 'workbench',
    sourceUrl: input.sourceUrl,
    internalUrl: input.internalUrl,
    internalWebUrl: input.internalWebUrl || undefined,
    pullRequests: prConfiguration({ ...previous, internalWebUrl: input.internalWebUrl }, input.prMode, input),
    issues:
      input.mode === 'version'
        ? undefined
        : issueConfiguration({ ...previous, internalWebUrl: input.internalWebUrl }, input),
    commitStrategy: input.commitStrategy ?? previous.commitStrategy,
    receivingIdentity: input.receivingIdentity ?? previous.receivingIdentity,
    sourceBranch: input.sourceBranch,
    targetBranch: input.targetBranch,
    mode: input.mode,
    internalPaths: input.internalPaths,
    mergePaths: input.mergePaths,
    commitClosureVerified: input.commitClosureVerified ?? previous.commitClosureVerified ?? false,
    stateDir: dirname(path),
    checks: previous.checks ?? [{ command: 'git', args: ['fsck', '--no-reflogs'] }],
    checkProfile: previous.checkProfile ?? 'git-integrity',
  });
}
