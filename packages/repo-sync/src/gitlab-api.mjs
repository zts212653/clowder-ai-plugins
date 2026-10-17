import { fail } from './config.mjs';
import { issueToken } from './issue-auth.mjs';
import { trustSystemCA } from './system-ca.mjs';

export function gitlabApi(config, settings = config.issues, family = 'ISSUE') {
  trustSystemCA();
  const token = issueToken(config, settings);
  const base = `${settings.apiUrl.replace(/\/$/, '')}/projects/${encodeURIComponent(settings.projectId)}`;
  async function request(path, method = 'GET', payload) {
    let response;
    try {
      response = await fetch(`${base}/${path}`, {
        method,
        redirect: 'error',
        headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        signal: AbortSignal.timeout(settings.timeoutMs ?? 30000),
      });
    } catch (error) {
      unavailable(error, family);
    }
    if (!response.ok) {
      await response.body?.cancel();
      try {
        fail(
          `${family}_API_REJECTED`,
          `内部平台 API 拒绝请求（HTTP ${response.status}）；请核对权限与配置后回读原对象`,
        );
      } catch (error) {
        error.httpStatus = response.status;
        const retry = response.headers.get('retry-after');
        error.retryAfterMs = /^\d+$/.test(retry ?? '') ? Math.min(3600000, Number(retry) * 1000) : 30000;
        throw error;
      }
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 2 * 1024 * 1024) fail('ISSUE_RESPONSE_INVALID', '内部 Issue API 响应过大，未采用');
      chunks.push(chunk);
    }
    try {
      return {
        value: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        next: response.headers.get('x-next-page'),
      };
    } catch {
      fail('ISSUE_RESPONSE_INVALID', '内部 Issue API 未返回有效 JSON，未采用');
    }
  }
  return {
    request: async (...args) => (await request(...args)).value,
    list: async (path) => {
      const result = [];
      let page = '1';
      for (let count = 0; count < 100; count++) {
        const response = await request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
        const items = listItems(path, response.value);
        result.push(...items);
        if (!nextPage(response, page, items.length)) return result;
        page = response.next;
      }
      fail('ISSUE_RESPONSE_LIMIT', 'Issue 查询范围超过分页上限，未静默截断，请收窄范围');
    },
  };
}

function listItems(path, value) {
  const items = !Array.isArray(value) && /^issues(?:\?|$)/.test(path) ? value?.issues : value;
  if (!Array.isArray(items) || items.some((item) => !item || typeof item !== 'object' || Array.isArray(item)))
    fail('ISSUE_RESPONSE_INVALID', '内部平台列表格式无效；Issue 支持数组或 issues 封套，PR 需要数组');
  return items;
}

function nextPage(response, page, length) {
  if (!response.next) {
    if (response.next === null && length === 100)
      fail('ISSUE_RESPONSE_INVALID', '完整页缺少分页回执，无法证明查询完整，未静默截断');
    return false;
  }
  if (!/^\d+$/.test(response.next) || Number(response.next) !== Number(page) + 1)
    fail('ISSUE_RESPONSE_INVALID', '内部 Issue API 分页未连续前进，停止而非截断');
  return true;
}

function unavailable(error, family) {
  if (
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT'].includes(
      error.cause?.code,
    )
  )
    fail(
      `${family}_API_TLS_UNTRUSTED`,
      'Node 未信任平台证书链。将企业 CA 安装到系统受信任证书库并重启；旧版 Node 24 使用 node --use-system-ca 启动。不要关闭证书校验。',
    );
  fail(`${family}_API_UNAVAILABLE`, '内部平台 API 连接失败或超时；请核对网络、证书与服务，不重复创建');
}
