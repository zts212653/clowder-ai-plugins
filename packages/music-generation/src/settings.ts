import { credentials, current, MusicError, object, projectId, type MusicDependencies, type MusicHost, type OwnerCall } from './types.js';
import { MusicConnectionFlows } from './connection-flows.js';
import { oauthHelper } from './oauth-helper.js';

export async function managedCredentials(host: MusicHost) {
  const project = projectId(await host.config.get('projectId'));
  const saved = await host.secrets.get('googleCredentials');
  if (!saved) throw new MusicError('configuration_required');
  try { return credentials(saved, project); }
  catch (error) { if (error instanceof MusicError) throw error; throw new MusicError('oauth_credentials_invalid'); }
}
export function assertConnected(check: { billingEnabled: boolean; vertexEnabled: boolean }) {
  if (!check.billingEnabled) throw new MusicError('cloud_billing_required');
  if (!check.vertexEnabled) throw new MusicError('vertex_api_required');
}
const failure = (error: unknown) => ({ render: 'status', advance: false, label: '需要检查 Cloud 配置或授权',
  data: { status: 'configuration_required', code: error instanceof MusicError ? error.code : 'connection_check_failed',
    message: '请在本卡片检查 Cloud 项目、授权、结算及 Vertex AI；检查不会生成音乐或自动充值。' } });

export function musicSettings(host: MusicHost, dependencies: MusicDependencies) {
  const draft = (params: unknown): Record<string, unknown> => object(params) && object(params.input) ? params.input : {};
  const selectedProject = async (params: unknown, fallback?: string) => projectId(draft(params).projectId ?? await host.config.get('projectId') ?? fallback);
  const execute = (importAdc: boolean) => async (params: unknown, _action: unknown, call?: OwnerCall) => {
    // Read-only test actions have the Host's settings fence, but no mutating owner-operation token.
    const fence = () => importAdc || call ? current(call) : Promise.resolve();
    await fence();
    try {
      const selected = importAdc ? await selectedProject(params) : projectId(await host.config.get('projectId'));
      const grant = importAdc ? credentials(await dependencies.readAdc(), selected) : await managedCredentials(host);
      await fence();
      const check = await dependencies.verifyConnection(grant, call?.signal);
      if (check.projectId !== selected) throw new MusicError('oauth_project_mismatch');
      assertConnected(check);
      await fence();
      const data = { status: 'connected', projectId: selected, billingEnabled: true, vertexEnabled: true,
        estimatedClipUsd: 0.04, estimatedProUsd: 0.08, actualChargedUsd: null, creditDeductionVerified: false };
      if (!importAdc) return { ok: true, message: 'Cloud 已连接；测试没有生成音乐', details: data };
      return { render: 'status', label: 'Cloud 已连接（尚未生成）', data,
        targetValues: { projectId: selected, googleCredentials: JSON.stringify(grant) } };
    } catch (error) {
      // Losing the owner request is not a normal connection result or permission to commit late secrets.
      await fence();
      if (!importAdc) return { ok: false, message: '请在本卡片检查 Cloud 项目与授权；测试没有生成音乐',
        details: { status: 'configuration_required', code: error instanceof MusicError ? error.code : 'connection_check_failed' } };
      return failure(error);
    }
  };
  const connection = (method: 'begin' | 'poll' | 'cancel') => async (params: unknown, _action: unknown, call?: OwnerCall) => {
    await current(call);
    try {
      // A connected installation already owns its OAuth client. A first-time installation
      // uses the owner's desktop application, never another first-party application's identity.
      const saved = method === 'begin' ? await host.secrets.get('googleCredentials') : undefined;
      const grant = saved ? credentials(saved) : undefined;
      const clientId = grant?.client_id ?? draft(params).oauthClientId ?? await host.config.get('oauthClientId');
      const clientSecret = grant?.client_secret ?? draft(params).oauthClientSecret ?? await host.secrets.get('oauthClientSecret');
      if (method === 'begin' && (typeof clientId !== 'string' || typeof clientSecret !== 'string')) throw new MusicError('oauth_client_required');
      const helper = oauthHelper(host.dataPath, { clientId: typeof clientId === 'string' ? clientId : '', clientSecret: typeof clientSecret === 'string' ? clientSecret : '' });
      const flows = new MusicConnectionFlows({ storage: host.storage, helper, assertCurrent: () => current(call) });
      const flow = method === 'begin' ? await flows.begin(await selectedProject(params)) : await flows[method]();
      await current(call);
      if (!flow) return { render: 'status', label: '尚未发起连接', data: { status: 'disconnected' }, advance: false };
      if (method === 'cancel') return { render: 'status', label: '本次连接已取消；已保存的授权不受影响', data: { status: 'canceled' } };
      const selected = await selectedProject(params, flow.projectId);
      if (flow.projectId !== selected) throw new MusicError('oauth_project_mismatch');
      if (flow.state === 'ready') {
        const adopted = await helper.completed(flow.flowId, selected);
        assertConnected(await dependencies.verifyConnection(adopted, call?.signal));
        await current(call);
        return { render: 'status', label: 'Cloud 授权已连接；请明确启用插件', data: { status: 'connected', projectId: selected },
          targetValues: { projectId: selected, googleCredentials: JSON.stringify(adopted) } };
      }
      return { render: method === 'poll' ? 'polling' : flow.authorizationUrl ? 'url' : 'status',
        label: flow.authorizationUrl ? '打开 Google 授权页（请勾选 Cloud 数据权限）' : `连接状态：${flow.state}`,
        data: { status: flow.state === 'failed' ? 'error' : flow.state === 'canceled' ? 'denied' : flow.state, projectId: selected, expiresAt: flow.expiresAt,
          ...(flow.authorizationUrl ? { url: flow.authorizationUrl } : {}) }, ...(method === 'poll' ? { advance: false } : {}) };
    } catch (error) { await current(call); return failure(error); }
  };
  return { actions: {
    'music.check': execute(false), 'music.import-adc': execute(true),
    'music.connect': connection('begin'), 'music.connection-status': connection('poll'), 'music.cancel-connection': connection('cancel'),
    'music.disconnect': async (input: unknown, action: unknown, call?: OwnerCall) => {
      await connection('cancel')(input, action, call);
      await current(call);
      return { render: 'status', label: '已断开本插件的 Cloud 授权；保留音乐和来源回执', data: { status: 'disconnected' }, targetValues: { googleCredentials: '' } };
    },
  } };
}
