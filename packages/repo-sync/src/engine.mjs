import { createHash } from 'node:crypto';
import { recoverDelivery } from './acceptance.mjs';
import { adoptionBaseline } from './adoption-baseline.mjs';
import { commitPolicy } from './commit-policy.mjs';
import { fail, validateConfig } from './config.mjs';
import { continuousPreview } from './continuous-preview.mjs';
import { execution, phase, safeError } from './execution.mjs';
import { GitReceiver } from './git.mjs';
import { confirmGitPr } from './git-pr.mjs';
import { associateIssues, settleIssues, syncIssues } from './issue-lifecycle.mjs';
import { assertLedger } from './ledger.mjs';
import { mapIssue, recordReceipts, templates } from './metadata.mjs';
import { checkPlan } from './plan.mjs';
import { prepareDelivery } from './preparation.mjs';
import { preservedInternalHead } from './preserved-tree.mjs';
import { git } from './process.mjs';
import { createPr, linkPr, prUrl } from './pull-requests.mjs';
import { recordDelivery } from './recording.mjs';
import { event, Store } from './store.mjs';
import { cancelVersion, selectTag, sourceStillValid, tags, versionTemplate } from './version.mjs';
import { VersionGitReceiver } from './version-git.mjs';
import { assertTransferWritable } from './transfer-state.mjs';

export class Receiver {
  constructor(input) {
    this.config = validateConfig(input);
    this.store = new Store(this.config.stateDir);
    this.git = this.config.mode === 'version' ? new VersionGitReceiver(this.config) : new GitReceiver(this.config);
  }
  async read() {
    const state = await this.store.read();
    if (state && (state.schema !== 1 || state.bindingId !== this.config.bindingId || !Array.isArray(state.deliveries)))
      fail('BINDING_CONFLICT', '台账版本或仓库绑定不匹配');
    if (state) assertLedger(state);
    return state;
  }
  async change(action, preserveError = false) {
    return this.store.locked(async () => {
      await assertTransferWritable(this.config);
      const state = await this.read();
      if (!state) fail('NOT_ADOPTED', '先核验并登记两侧已有基线');
      if (execution()?.deliveryId && this.active(state)?.id !== execution().deliveryId)
        fail('DELIVERY_CHANGED', '活动交付已变化，已在写锁内停止旧页面操作；请刷新核对');
      const original = this.active(state);
      if (original) recordDelivery(original, this.config, 'execution', state.issues);
      try {
        await action(state);
      } catch (error) {
        const delivery = this.active(state);
        if (delivery) {
          const failure = safeError(error);
          recordFailure(delivery, failure, preserveError);
          event(state, delivery, failure.message);
        }
        await phase('ledger-save', '保存交付台账', () => this.store.save(state), false);
        throw error;
      }
      const recorded = original ?? this.active(state);
      if (recorded) recordDelivery(recorded, this.config, 'execution', state.issues);
      await phase('ledger-save', '保存交付台账', () => this.store.save(state), false);
      return state;
    });
  }
  active(state) {
    return state.deliveries.find(
      (item) => item.id === state.activeId && !['COMPLETE', 'CANCELLED'].includes(item.status),
    );
  }
  async adopt(upstream, internal) {
    return this.store.locked(async () => {
      await assertTransferWritable(this.config);
      if (await this.read()) fail('ALREADY_ADOPTED', '已有台账，不能重新初始化覆盖');
      const heads = await this.git.fetch();
      ({ upstream, internal } = await phase('baseline-check', '核验 U0 / I0 与历史', () =>
        adoptionBaseline(this, upstream, internal, heads),
      ));
      const state = {
        schema: 1,
        mode: this.config.mode,
        bindingId: this.config.bindingId,
        initial: { upstream, internal },
        accepted: { upstream, internal },
        latest: heads.upstream,
        observedInternal: internal,
        activeId: null,
        queue: [],
        deliveries: [],
        issues: {},
        events: [],
      };
      event(state, null, '已有两仓基线核验并登记；未修改内部 main');
      await phase('baseline-save', '登记已有基线', () => this.store.save(state), false);
      return state;
    });
  }
  async setQueue(plans) {
    if (this.config.mode === 'version') fail('WRONG_MODE', '按版本更新请选择目标 tag');
    return this.change(async (state) => {
      await this.replaceQueue(state, plans, await this.git.fetch());
    });
  }
  async replaceQueue(state, plans, heads, ceiling = heads.upstream) {
    if (this.active(state)) fail('RECOVERY_FIRST', '存在未完成交付，先恢复，不重新扫描');
    await preservedInternalHead(this, state, heads.internal);
    let base = state.accepted.upstream;
    for (const plan of plans) {
      await checkPlan(this.git, plan, base, heads.upstream);
      base = plan.target;
    }
    if (base !== ceiling) fail('SOURCE_UNPROVEN', '交付清单没有完整覆盖冻结上游范围');
    state.queue = structuredClone(plans);
    state.latest = heads.upstream;
    state.scannedAt = new Date().toISOString();
    event(state, null, `已冻结 ${plans.length} 笔连续上游交付`);
  }
  async start(expectedTarget) {
    return this.change(async (state) => {
      if (this.active(state)) fail('RECOVERY_FIRST', '先完成原交付，不新建重复对象');
      const plan = state.queue[0];
      if (!plan) fail('NO_DELIVERY', '没有待接收交付，先发现更新');
      if (expectedTarget && plan.target !== expectedTarget)
        fail('QUEUE_CHANGED', '待同步目标已变化，未发起交付；请刷新确认 tag / PR 和 commit 后再开始');
      execution()?.associate?.(null); // The next delivery preflight belongs to the run, not the previous PR.
      const heads = await this.git.fetch();
      await preservedInternalHead(this, state, heads.internal);
      await sourceStillValid(this, plan, heads);
      const id = createHash('sha256')
        .update(
          `${state.bindingId}:${plan.source.id}:${plan.target}${this.config.mode === 'version' ? `:${state.accepted.internal}:${state.deliveries.length}` : retrySuffix(state, plan)}`,
        )
        .digest('hex')
        .slice(0, 24);
      const delivery = {
        ...structuredClone(plan),
        id,
        branch: `sync/${id}`,
        base: { ...state.accepted },
        status: this.config.mode === 'version' ? 'CODE_PREPARE_REQUIRED' : 'ISSUES_REQUIRED',
        candidate: null,
        commitPolicy: commitPolicy(this.config),
        issueResults: {},
        ...(retrySource(state, plan) ? { supersedes: retrySource(state, plan).id } : {}),
      };
      recordDelivery(delivery, this.config, 'start');
      if (delivery.commitPolicy.strategy !== 'rewrite') delete delivery.source.developmentReplay;
      if (this.config.mode === 'continuous') delivery.preview = await continuousPreview(this, delivery);
      delivery.commits = (
        await git(this.git.directory, [
          'rev-list',
          '--reverse',
          '--topo-order',
          `${delivery.base.upstream}..${delivery.target}`,
        ])
      ).split('\n');
      delivery.commitDetails = [];
      for (const source of delivery.source.developmentReplay?.commits ?? delivery.commits)
        delivery.commitDetails.push({ sha: source, subject: await git(this.git.directory, ['show', '-s', '--format=%s', source]) });
      state.deliveries.push(delivery);
      state.activeId = id;
      if (state.automation) delete state.automation.restartOf;
      event(
        state,
        delivery,
        this.config.mode === 'version'
          ? '版本交付已冻结；核对文件规则后准备一个候选分支'
          : '交付已冻结；内部 Issue 在平台创建或复用，然后登记映射',
      );
    });
  }
  async linkIssue(sourceId, internalId, url, options) {
    if (this.config.issues)
      fail('ISSUE_MANAGED_AUTOMATICALLY', '已启用 Issue 自动化，请执行原对象回读，不用人工编号覆盖来源映射');
    return this.change(async (state) => {
      const delivery = this.requireActive(state);
      await phase(
        'issue-mapping',
        '登记 / 纠正 Issue 来源映射',
        () => mapIssue(state, delivery, sourceId, internalId, prUrl(this.config, url, 'Issue'), options),
        false,
      );
      delete delivery.error;
      event(state, delivery, '内部 Issue 来源映射已登记');
    });
  }
  requireActive(state) {
    const active = this.active(state);
    if (!active) fail('NO_ACTIVE_DELIVERY', '没有未完成交付');
    if (active.cancellation?.status === 'REQUESTED')
      fail('CANCELLATION_PENDING', '原 PR 撤销结果待回读，请继续完成撤销；不能恢复普通同步或创建新对象。');
    if (active.repair && active.repair.status !== 'COMPLETE')
      fail('REPAIR_PENDING', '修复流程尚未完成，请继续原修复 PR，不能重新执行旧候选。');
    return active;
  }
  prepare() {
    return this.change((state) => prepareDelivery(this, state));
  }
  syncIssues() {
    return this.change((state) => syncIssues(this, state));
  }
  requirePreparation(state, delivery) {
    if (delivery.acceptedInternal) fail('METADATA_ONLY', '代码已接受，仅补元数据');
    if (!delivery.issues.every((issue) => state.issues[issue.sourceId]))
      fail('ISSUES_REQUIRED', '先登记全部内部 Issue 映射');
    if (this.config.mode !== 'version' && this.config.commitClosureVerified !== true)
      fail(
        'PLATFORM_CLOSURE_UNVERIFIED',
        '请在准备代码步骤查看并确认提交消息关单规则：外部 Closes #123 可能关闭内部同号 Issue。原基线保留，确认前不发布候选。',
      );
    if (!this.config.checks?.length) fail('CHECKS_REQUIRED', '至少配置一项核心/插件检查，不能把未检查当通过');
  }
  linkPr(url, options) {
    return this.change((state) =>
      phase(
        'platform-pr',
        '核验候选并登记或纠正 PR 引用',
        async () => {
          await linkPr(this, state, url, options);
          await associateIssues(this, state, this.requireActive(state));
        },
        false,
      ),
    );
  }
  createPr() {
    if (this.config.pullRequests?.mode === 'git') return this.prepare();
    return this.change((state) => {
      const delivery = this.requireActive(state);
      return this.finishPr(state, delivery);
    });
  }
  deliveryTemplates(state, delivery) {
    return this.config.mode === 'version' ? versionTemplate(delivery) : templates(delivery, state.issues);
  }
  async finishPr(state, delivery) {
    await (this.config.pullRequests?.mode === 'git'
      ? confirmGitPr(this, state, delivery)
      : createPr(this, state, delivery, this.deliveryTemplates(state, delivery)));
    await associateIssues(this, state, delivery);
  }
  async recover() {
    return this.change(async (state) => {
      const delivery = this.requireActive(state);
      await recoverDelivery(this, state, delivery);
      if (delivery.status === 'PR_REQUIRED' && this.config.pullRequests?.mode === 'git' && delivery.gitPr)
        await confirmGitPr(this, state, delivery);
      await associateIssues(this, state, delivery);
      await settleIssues(this, state, delivery);
    });
  }
  async receipts(observations) {
    if (this.config.issues) return this.syncIssues();
    return this.change(async (state) => {
      const delivery = this.requireActive(state);
      if (delivery.status !== 'CODE_ACCEPTED_PENDING_METADATA')
        fail('CODE_NOT_ACCEPTED', '先核验实际 main 并记录接受版本');
      if ((await this.git.fetch()).internal !== delivery.acceptedInternal)
        fail('ACCEPTED_HEAD_CONFLICT', '保存接收记录前 main 已改变，暂停核对');
      await phase(
        'receipts-save',
        '核对 Issue 状态并保存本笔接收记录',
        () => recordReceipts(state, delivery, observations, this.git),
        false,
      );
      delivery.status = 'COMPLETE';
      delete delivery.error;
      state.queue.shift();
      event(state, delivery, '本笔接收记录已保存；关联 Issue 可以保持打开，下一笔已开放');
    });
  }
  async status() {
    const state = await this.read();
    return state
      ? {
          ...state,
          active: this.active(state),
          templates: this.active(state)
            ? this.config.mode === 'version'
              ? versionTemplate(this.active(state))
              : templates(this.active(state), state.issues)
            : null,
        }
      : null;
  }
  tags() {
    return tags(this);
  }
  selectTag(name) {
    return selectTag(this, name);
  }
  cancelVersion() {
    return phase('version-cancel', '撤销未发布交付并保留历史', () => cancelVersion(this));
  }
}
function retrySource(state, plan) {
  return state.deliveries.findLast((d) => d.source.id === plan.source.id && d.target === plan.target && d.status === 'CANCELLED');
}
function retrySuffix(state, plan) {
  const previous = retrySource(state, plan);
  return previous ? `:retry:${state.deliveries.filter((d) => d.source.id === plan.source.id && d.target === plan.target).length}` : '';
}
function recordFailure(delivery, error, preserveError) {
  if (preserveError && delivery.error) return;
  delivery.error = { code: error.code ?? 'EXECUTION_FAILED', message: error.message };
  if (error.details) delivery.error.details = error.details;
}
