import { affectedSystemsSchema, routingFocusSchema } from '../classification/routing-context.js';
import {
  type CoordinationDetail,
  type CoordinationSnapshot,
  type CoordinationSource,
  type IssueClassification,
  type IssueInvestigation,
  type IssueRef,
  type IssueRelation,
  type IssueSourceFact,
  type IssueSourceProfile,
  type IssueSourceSnapshot,
  issueCatalogFact,
  issueFeatureBindings,
  issueRefKey,
  relationKey,
  type SourcePreference,
  safeIssueUrl,
} from '../model/index.js';
import type { CoordinationStorage } from './IssueCoordinationStore.js';

export interface CoordinationBinding {
  profile: IssueSourceProfile;
  /** Check the Host's current grant on EVERY read/write, including cached data. */
  authorize(): Promise<boolean>;
  catalog(refresh: boolean): Promise<IssueSourceSnapshot>;
  detail(ref: IssueRef, offset?: number, version?: string): Promise<CoordinationDetail>;
  classifications?: IssueClassification[];
}
function readableClassifications(binding: CoordinationBinding, issues: IssueSourceFact[]): IssueClassification[] {
  return (binding.classifications ?? []).filter(
    ({ source }) =>
      source.provider === binding.profile.provider &&
      source.instance === binding.profile.instance &&
      source.repositoryId === binding.profile.repositoryId &&
      issues.some(
        (issue) =>
          issue.id === source.issueId &&
          issue.number === source.number &&
          !issue.unavailable &&
          !issueFeatureBindings(issue).length,
      ),
  );
}
export class CoordinationDenied extends Error {
  readonly status = 403;
}
const denied = (error: unknown) =>
  error instanceof CoordinationDenied || [401, 403].includes((error as { status?: number })?.status ?? 0);
function requireReadable(snapshot: IssueSourceSnapshot) {
  if (snapshot.failures.some((f) => f.kind === 'auth')) throw new CoordinationDenied('来源未授权，内容不可读取');
}
export class IssueCoordinationService {
  constructor(
    private readonly store: CoordinationStorage,
    private readonly bindings: CoordinationBinding[],
    private readonly actor: string,
  ) {
    if (new Set(bindings.map((b) => b.profile.id)).size !== bindings.length)
      throw new Error('Duplicate source identity');
  }
  private async bound(id: string) {
    const b = this.bindings.find((b) => b.profile.id === id);
    if (!b || !(await b.authorize())) throw new CoordinationDenied('来源未授权，内容不可读取');
    return b;
  }
  private validateRef(ref: IssueRef) {
    if (!ref || !ref.sourceId || !ref.issueId || !Number.isSafeInteger(ref.number) || ref.number < 1)
      throw new Error('Invalid issue reference');
  }
  async load(refresh = false): Promise<CoordinationSnapshot> {
    const readable = new Set<string>();
    const sources: CoordinationSource[] = await Promise.all(
      this.bindings.map(async (b) => {
        const preference = (await this.store.read<SourcePreference>('preferences', b.profile.id)) ?? {
          revision: 0,
          value: { name: b.profile.name, enabled: true, branch: '', base: '' },
        };
        const empty = { profile: b.profile, preference, issues: [], work: [] };
        if (!preference.value.enabled) return empty;
        try {
          await this.bound(b.profile.id);
          const snapshot = await b.catalog(refresh);
          requireReadable(snapshot);
          const work = await this.store.list<IssueInvestigation>('work:' + b.profile.id);
          await this.bound(b.profile.id);
          readable.add(b.profile.id);
          const invalid = snapshot.issues.some((f) => !f.id);
          return {
            ...empty,
            issues: snapshot.issues.filter((f) => f.id).map(issueCatalogFact),
            classifications: readableClassifications(b, snapshot.issues),
            work,
            checkedAt: snapshot.lastCompleteAt,
            retryAt: snapshot.retryAt,
            error: invalid
              ? '来源缺少稳定 Issue ID，请修复适配器'
              : snapshot.failures.map((f) => f.message).join('；') || undefined,
          };
        } catch (error) {
          // Failure never makes cached private content an authorization bypass.
          if (denied(error)) return { ...empty, error: '来源未授权，内容不可读取' };
          try {
            await this.bound(b.profile.id);
            const work = await this.store.list<IssueInvestigation>('work:' + b.profile.id);
            let old: IssueSourceSnapshot | undefined;
            try {
              old = await b.catalog(false);
              requireReadable(old);
            } catch (e) {
              if (denied(e)) throw e;
            }
            await this.bound(b.profile.id);
            readable.add(b.profile.id);
            return {
              ...empty,
              issues: old?.issues.filter((f) => f.id).map(issueCatalogFact) ?? [],
              classifications: readableClassifications(b, old?.issues ?? []),
              work,
              checkedAt: old?.lastCompleteAt,
              error: old ? '更新失败，保留上次可读取内容' : '来源暂不可用，本地记录仍保留',
            };
          } catch (e) {
            return { ...empty, error: denied(e) ? '来源未授权，内容不可读取' : '来源暂不可用，请检查连接与授权' };
          }
        }
      }),
    );
    const relations = [];
    for (const r of await this.store.list<IssueRelation>('relations')) {
      if (!r.value.refs.every((ref) => readable.has(ref.sourceId))) continue;
      try {
        await Promise.all(r.value.refs.map((ref) => this.bound(ref.sourceId)));
        relations.push(r);
      } catch {
        /* both grants required */
      }
    }
    return { sources, relations };
  }
  async detail(ref: IssueRef, offset = 0, version?: string) {
    this.validateRef(ref);
    if (!Number.isSafeInteger(offset) || offset < 0 || (offset > 0 && !version)) throw new Error('Invalid detail page');
    const b = await this.bound(ref.sourceId),
      result = await b.detail(ref, offset, version);
    await this.bound(ref.sourceId);
    if (result.fact && (result.fact.id !== ref.issueId || result.fact.number !== ref.number))
      throw new Error('来源身份已变化，请重新读取列表');
    return result;
  }
  async savePreference(sourceId: string, value: SourcePreference, revision: number) {
    await this.bound(sourceId);
    if (typeof value.enabled !== 'boolean') throw new Error('Invalid source preference');
    const clean = {
      enabled: value.enabled,
      name: this.text(value.name, 100),
      branch: this.text(value.branch, 200),
      base: this.text(value.base, 200),
    };
    return this.store.put('preferences', sourceId, clean, revision);
  }
  async saveWork(value: IssueInvestigation, revision: number) {
    this.validateRef(value.ref);
    await this.bound(value.ref.sourceId);
    const clean = {
      ref: { sourceId: value.ref.sourceId, issueId: value.ref.issueId, number: value.ref.number },
    } as IssueInvestigation;
    for (const field of [
      'title',
      'sourceVersion',
      'module',
      'tags',
      'notes',
      'evidence',
      'branch',
      'base',
      'patch',
      'taskUrl',
      'verificationEvidence',
      'labelDraft',
    ] as const)
      clean[field] = this.text(value[field]);
    if (
      !['unknown', 'common', 'internal'].includes(value.scope) ||
      !['pending', 'not-needed', 'applied'].includes(value.adoption) ||
      !['pending', 'failed', 'passed'].includes(value.verification)
    )
      throw new Error('Invalid work state');
    if (value.affectedSystems !== undefined) clean.affectedSystems = affectedSystemsSchema.parse(value.affectedSystems);
    if (value.routingFocus !== undefined) clean.routingFocus = routingFocusSchema.parse(value.routingFocus);
    clean.scope = value.scope;
    clean.adoption = value.adoption;
    clean.verification = value.verification;
    if (clean.verification === 'passed' && (!clean.verificationEvidence.trim() || !clean.base.trim()))
      throw new Error('验证通过需要代码基线和验证证据');
    if (clean.taskUrl && !safeIssueUrl(clean.taskUrl)) throw new Error('任务链接必须为 http(s) 地址');
    await this.bound(value.ref.sourceId);
    return this.store.put('work:' + value.ref.sourceId, issueRefKey(value.ref), clean, revision);
  }
  async saveRelation(value: IssueRelation, revision: number) {
    if (!Array.isArray(value.refs) || value.refs.length !== 2) throw new Error('关联需要两个问题');
    value.refs.forEach((ref) => this.validateRef(ref));
    if (issueRefKey(value.refs[0]) === issueRefKey(value.refs[1])) throw new Error('不能关联自身');
    await Promise.all(value.refs.map((ref) => this.bound(ref.sourceId)));
    if (!['possible', 'same-cause', 'port'].includes(value.kind) || typeof value.active !== 'boolean')
      throw new Error('Invalid relation');
    const reason = this.text(value.reason);
    if (!reason.trim()) throw new Error('请记录关联依据');
    if (!Array.isArray(value.sourceVersions) || value.sourceVersions.length !== 2) throw new Error('缺少来源版本');
    const key = relationKey(value.refs),
      previous = await this.store.read<IssueRelation>('relations', key);
    const clean: IssueRelation = {
      refs: value.refs,
      kind: value.kind,
      reason,
      conclusion: this.text(value.conclusion),
      sourceVersions: [this.text(value.sourceVersions[0]), this.text(value.sourceVersions[1])],
      active: value.active,
      createdBy: previous?.value.createdBy ?? this.actor,
    };
    return this.store.put('relations', key, clean, revision);
  }
  private text(value: unknown, max = 40_000): string {
    if (typeof value !== 'string' || value.length > max) throw new Error('字段无效或内容过长');
    return value;
  }
}
