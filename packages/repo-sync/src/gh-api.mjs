import { AsyncLocalStorage } from 'node:async_hooks';
import { fail } from './config.mjs';
import { requireGithubToken } from './github-auth.mjs';
import { githubRequest, githubUrl } from './github-http.mjs';

const context = new AsyncLocalStorage();
export const withGithub = (config, operation) => context.run(config, operation);
export async function api(path, paged = false) {
  let url = githubUrl(path);
  const first = url.pathname,
    seen = new Set(),
    items = [];
  for (let count = 0; count < 100; count++) {
    if (seen.has(url.href) || url.pathname !== first)
      fail('GITHUB_RESPONSE_INVALID', 'GitHub 分页未前进或改变了查询对象，未采用不完整清单。');
    seen.add(url.href);
    const response = await githubRequest(context.getStore(), url.href);
    if (!paged) return response.value;
    if (!Array.isArray(response.value)) fail('GITHUB_RESPONSE_INVALID', 'GitHub 分页列表格式无效。');
    items.push(...response.value);
    const link = response.headers.get('link') ?? '';
    const next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
    if (!next) {
      if (/rel="next"/.test(link)) fail('GITHUB_RESPONSE_INVALID', 'GitHub 分页回执无法解析，未静默截断。');
      return items;
    }
    url = githubUrl(next);
  }
  fail('GITHUB_RESPONSE_LIMIT', 'GitHub 分页超过读取上限，请收窄同步范围；不会静默截断。');
}
export async function graphql(query, variables) {
  requireGithubToken(context.getStore());
  if (!/^\s*query\b/.test(query)) fail('GITHUB_QUERY_REJECTED', '来源同步只允许固定的只读 GraphQL 查询。');
  const pages = [],
    seen = new Set();
  let endCursor;
  for (let count = 0; count < 100; count++) {
    const { value } = await githubRequest(context.getStore(), 'graphql', {
      query,
      variables: { ...variables, ...(endCursor ? { endCursor } : {}) },
    });
    validateGraph(value);
    pages.push(value);
    endCursor = nextCursor(value, query, seen);
    if (!endCursor) return pages;
    seen.add(endCursor);
  }
  fail('GITHUB_RESPONSE_LIMIT', 'GitHub 关联查询超过分页上限，未静默截断。');
}
function validateGraph(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value.errors != null && !Array.isArray(value.errors))
  )
    fail('GITHUB_RESPONSE_INVALID', 'GitHub 关联响应格式无效，未采用。');
  if (value.errors?.some((error) => error?.type === 'RATE_LIMITED'))
    fail('GITHUB_RATE_LIMITED', 'GitHub 关联查询额度受限，请稍后重试；不会采用部分关联。');
  if (!value?.data || value.errors?.length)
    fail(
      'METADATA_INCOMPLETE',
      'GitHub 关联查询不完整或权限不足。请核对 Issues / Pull requests 读取权限；不会把缺失关联当作无 Issue。',
    );
}
function nextCursor(value, query, seen) {
  const connection = value.data.repository?.pullRequest?.closingIssuesReferences ?? value.data.node?.timelineItems;
  const page = connection?.pageInfo;
  if (!page) {
    if (query.includes('$endCursor')) fail('METADATA_INCOMPLETE', 'GitHub 关联查询缺少完整分页回执，已暂停。');
    return null;
  }
  if (!Array.isArray(connection.nodes)) fail('METADATA_INCOMPLETE', 'GitHub 关联清单格式无效，未采用部分数据。');
  if (typeof page.hasNextPage !== 'boolean') fail('METADATA_INCOMPLETE', 'GitHub 关联分页状态无效。');
  if (!page.hasNextPage) return null;
  if (typeof page.endCursor !== 'string' || !page.endCursor || seen.has(page.endCursor))
    fail('METADATA_INCOMPLETE', 'GitHub 关联分页未前进，已暂停。');
  return page.endCursor;
}
