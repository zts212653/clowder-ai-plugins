import type { CoordinationHost } from '../model/issue-coordination';

/** The embedding Host supplies authentication and cancellation; no implicit credentials. */
export function createCoordinationClient(request: (path: string, options?: RequestInit) => Promise<Response>, legacyUrl?: string): CoordinationHost {
  async function call(path: string, body?: unknown) {
    const response = await request('/api/issue-coordination/' + path, { cache: 'no-store',
      ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-issue-coordination': 'local-work' }, body: JSON.stringify(body) }) });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const validation = response.status === 400 && typeof body?.error === 'string' && body.error.length <= 300 ? body.error : undefined;
      const error = new Error(response.status === 409 ? '其他页面已修改此记录，请重新读取并核对后保存' : [401,403].includes(response.status) ? '来源未授权' : validation ?? '读取或保存失败，请检查来源服务'); Object.assign(error, { status: response.status }); throw error;
    }
    return response.json();
  }
  return { load: refresh => call(refresh ? 'refresh' : 'state', refresh ? {} : undefined),
    detail: (ref, offset, version) => call('detail', { ref, offset, version }), saveWork: (value, expectedRevision) => call('work', { value, expectedRevision }),
    saveRelation: (value, expectedRevision) => call('relation', { value, expectedRevision }),
    savePreference: (sourceId, value, expectedRevision) => call('preference', { sourceId, value, expectedRevision }), legacyUrl };
}
