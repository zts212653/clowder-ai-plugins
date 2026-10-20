import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fail, validateConfig } from './config.mjs';
import { safeError } from './execution.mjs';
import { api, graphql, withGithub } from './gh-api.mjs';
import { githubAuthentication } from './github-auth.mjs';
import { githubRepository } from './github.mjs';
import { gitlabApi } from './gitlab-api.mjs';
import { apiSettings, authenticationStatus } from './issue-auth.mjs';
import { preservedInternalHead } from './preserved-tree.mjs';
import { privateLocation } from './private-config.mjs';
import { command, git } from './process.mjs';
import { prUrl } from './pull-requests.mjs';

// This verifies a staged transfer. It never adopts a baseline, changes cursors, or writes platform objects.
export async function transferPreflight(receiver, options = {}) {
  const checks = [];
  const check = async (key, label, operation) => {
    try {
      const message = await operation();
      checks.push({ key, label, status: 'PASSED', ...(message ? { message } : {}) });
      return true;
    } catch (error) {
      checks.push({ key, label, status: 'FAILED', ...safeError(error) });
      return false;
    }
  };
  await check('runtime-node', 'Node.js 运行环境', () => {
    if (Number(process.versions.node.split('.')[0]) < 24)
      fail('TRANSFER_NODE_REQUIRED', '需要 Node.js 24 或更新版本。请更换运行环境并重新检查。');
    return '当前 Node.js 满足运行要求。';
  });
  const gitReady = await check('runtime-git', 'Git 可执行程序', async () => {
    await command('git', ['--version'], { timeout: 20000 });
    return '服务进程可以启动 Git；仓库访问权限将在下方检查。';
  });
  const pathReady = await check('private-path', '私有台账路径与写入权限', () => writableState(receiver.config));
  let config, state;
  const bindingReady = await check('binding', '配置、台账与仓库绑定', async () => {
    config = validateConfig(receiver.config);
    if (receiver.config.bindingId && config.bindingId !== receiver.config.bindingId)
      fail('BINDING_CONFLICT', '配置与迁移包的仓库绑定不同。请恢复原仓库、分支和文件规则后重新检查。');
    state = await receiver.read();
    return state ? '历史、映射和原仓库绑定有效；未重建台账。' : '配置模板尚未接管基线；不会自动初始化。';
  });
  const objectsReady = await check('objects', 'Git 对象完整性', async () => {
    requireChecks(gitReady && pathReady && bindingReady);
    await verifyObjects(receiver);
    return '本地 Git 对象完整，或将在仓库检查时首次下载。';
  });
  await check('repositories', '来源历史、内部 main 与原候选分支', async () => {
    requireChecks(gitReady && pathReady && bindingReady && objectsReady);
    const heads = await receiver.git.fetch();
    if (!state) return '两侧仓库和目标分支可以读取；请继续核验并登记已有基线。';
    if (!(await receiver.git.isAncestor(state.accepted.upstream, heads.upstream)))
      fail('SOURCE_REWRITTEN', '来源分支不包含已接受版本。请核对来源仓库或历史改写，修复后重新检查；未推进游标。');
    await receiver.git.baseline(state.accepted.upstream, state.accepted.internal);
    const active = receiver.active(state);
    if (active) await verifyActive(receiver, active, heads.internal);
    else await preservedInternalHead(receiver, structuredClone(state), heads.internal);
    return '来源历史和内部接收位置与原台账相符；原 Issue / PR 映射保留，未推进游标。';
  });
  await check('github-auth', 'GitHub API 读取认证', async () => {
    requireChecks(bindingReady);
    if (config.mode !== 'continuous') return '按版本更新不读取 GitHub Issue / PR 元数据，无需 API Token。';
    if (!githubAuthentication(config).available)
      fail(
        'GITHUB_AUTH_REQUIRED',
        '请先在当前项目提供自己的 GitHub 读取 Token，再重新检查迁移。Git 凭据不能替代 API 认证。',
      );
    await (options.verifySource ?? verifySource)(config);
    return 'GitHub 认证可以读取配置的来源仓库与当前登录身份。';
  });
  await check('platform-auth', '内部平台 API 认证与项目归属', async () => {
    requireChecks(bindingReady);
    if (!apiSettings(config)) return '当前内部方式不使用 API；Git 读取认证已在仓库检查中验证。';
    if (!authenticationStatus(config).available)
      fail(
        'ISSUE_AUTH_REQUIRED',
        '请先在当前项目提供自己的内部平台 Token，再重新检查迁移；无需改动原 Issue / PR 映射。',
      );
    await (options.verifyPlatform ?? verifyPlatform)(config);
    return '内部 API 认证有效，返回项目与配置的内部仓库相符。';
  });
  return checks;
}

function requireChecks(ready) {
  if (!ready) fail('TRANSFER_PREREQUISITE_FAILED', '请先修复上方未通过的运行环境、路径或绑定检查，再重新检查。');
}
async function writableState(config) {
  if (!isAbsolute(config.stateDir ?? ''))
    fail('INVALID_STATE_DIR', '请为当前环境选择绝对路径的私有台账目录；不能直接使用另一台机器的路径。');
  const probe = join(config.stateDir, `.migration-probe-${randomUUID()}`);
  await privateLocation(probe);
  await outsideBareRepository(config.stateDir);
  try {
    if ((await lstat(config.stateDir)).isSymbolicLink())
      fail('TRANSFER_PATH_UNSAFE', '台账目录不能是符号链接；请选择当前环境的独立私有目录。');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await mkdir(config.stateDir, { recursive: true });
    const handle = await open(probe, 'wx', 0o600);
    try {
      await handle.writeFile('repo-sync migration permission probe');
    } finally {
      await handle.close();
      await unlink(probe);
    }
  } catch (error) {
    if (error.safeToDisplay) throw error;
    fail('TRANSFER_PATH_UNWRITABLE', '当前服务无法写入迁移台账目录。请检查目录权限、磁盘空间和占用后重新检查。');
  }
  return '台账位于工作仓和插件安装目录之外，当前服务具有写入权限。';
}
async function outsideBareRepository(directory) {
  for (let path = resolve(directory); ; path = dirname(path)) {
    try {
      const [head, objects, refs] = await Promise.all(
        ['HEAD', 'objects', 'refs'].map((name) => lstat(join(path, name))),
      );
      if (head && objects.isDirectory() && refs.isDirectory())
        fail('PRIVATE_CONFIG_IN_REPOSITORY', '私有台账不能放在裸 Git 仓库中。请选择独立目录后重新检查迁移。');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (dirname(path) === path) return;
  }
}
async function verifyObjects(receiver) {
  let stat;
  try {
    stat = await lstat(receiver.git.directory);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink())
    fail('TRANSFER_OBJECTS_UNSAFE', 'Git 对象目录类型无效。请重新导入完整迁移包，不要手工替换对象目录。');
  try {
    if ((await readFile(join(receiver.git.directory, 'repo-sync-owner'), 'utf8')) !== receiver.config.bindingId)
      fail('OBJECT_STORE_OWNER_CONFLICT', 'Git 对象目录属于其他绑定。请恢复原迁移包或选择独立目录后重新导入。');
    await git(receiver.git.directory, ['fsck', '--no-reflogs']);
  } catch (error) {
    if (error.code === 'OBJECT_STORE_OWNER_CONFLICT') throw error;
    fail(
      'TRANSFER_OBJECTS_INCOMPLETE',
      '迁移的 Git 对象缺失或损坏。请从原环境重新导出完整迁移包；原历史和映射保留，不能重置台账。',
    );
  }
}
async function verifyActive(receiver, delivery, internal) {
  let merged = false;
  if (internal !== delivery.base.internal) {
    if (
      !delivery.candidate ||
      !delivery.prUrl ||
      !delivery.checks?.passed ||
      delivery.checks.head !== delivery.candidate ||
      (delivery.acceptedInternal && internal !== delivery.acceptedInternal)
    )
      fail(
        'MERGE_UNATTRIBUTABLE',
        '内部 main 已变化，但原候选、通过的检查或 PR 归属证据不完整。请核对原 PR 后重新检查；不会推进游标。',
      );
    prUrl(receiver.config, delivery.prUrl);
    await receiver.git.verify(delivery, internal);
    merged = true;
  }
  if (delivery.candidate) {
    const remote = await receiver.git.remoteBranch(delivery.branch);
    if (remote && remote !== delivery.candidate)
      fail('CANDIDATE_CONFLICT', '原同步分支的远端 commit 与冻结候选不同。请核对原 PR 和分支；不会覆盖或新建 PR。');
    if (!remote && delivery.prUrl && !merged)
      fail('CANDIDATE_MISSING', '原 PR 尚未合入，但对应同步分支已不存在。请恢复原分支或核对原 PR；不会重复创建 PR。');
  }
}
async function verifySource(config) {
  const repository = githubRepository(config.sourceUrl);
  return withGithub(config, async () => {
    const value = await api(`repos/${repository}`);
    if (
      typeof value?.node_id !== 'string' ||
      !value.node_id ||
      typeof value.full_name !== 'string' ||
      value.full_name.toLowerCase() !== repository.toLowerCase()
    )
      fail('GITHUB_REPOSITORY_MISMATCH', 'GitHub 返回的仓库身份与来源地址不同。请核对来源地址或仓库更名后重新检查。');
    const pages = await graphql('query RepoSyncMigrationViewer { viewer { login } }', {});
    if (typeof pages[0]?.data?.viewer?.login !== 'string' || !pages[0].data.viewer.login)
      fail('GITHUB_AUTH_INVALID', '无法确认 GitHub Token 对应的登录身份。请重新提供认证后检查。');
  });
}
async function verifyPlatform(config) {
  const project = await gitlabApi(config, apiSettings(config)).request('');
  const normalize = (value) => new URL(value).href.replace(/\/+$/, '');
  try {
    if (normalize(project?.web_url) !== normalize(config.internalWebUrl)) throw new Error();
  } catch {
    fail(
      'PLATFORM_PROJECT_MISMATCH',
      '内部 API 返回的项目与内部仓库网页地址不一致。请核对项目地址和认证范围后重新检查；不会创建 Issue 或 PR。',
    );
  }
}
