import { pathToFileURL } from 'node:url';

const TARGETS = new Set([
  'plugin-contract', 'plugin-sdk', 'companion', 'enterprise-workflow',
  'connector-telegram', 'connector-dingtalk', 'connector-feishu', 'connector-wecom-agent',
  'connector-wecom-bot', 'connector-weixin', 'connector-xiaoyi', 'personal-chrome-companion',
  'video-analysis', 'video-generation', 'weixin-mp', 'wechat-visible-reader',
  'genoffice-docx', 'xiangqi', 'github-operations',
].map((name) => `@clowder-ai/${name}`));

// Only credential-backed GETs to the npm registry; never print raw responses or errors.
export async function inspectPublisher({ token, fetchImpl = fetch }) {
  if (!token) return { configured: false };
  async function read(path, select) {
    try {
      const response = await fetchImpl(`https://registry.npmjs.org${path}`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
      if (!response.ok) return { status: response.status };
      const body = await response.json();
      return { status: response.status, ...select(body) };
    } catch {
      return { error: 'request_failed' };
    }
  }
  const whoami = await read('/-/whoami', (body) => ({
    username: typeof body.username === 'string' && /^[a-z0-9_-]{1,100}$/.test(body.username)
      && !body.username.includes(token) ? body.username : undefined,
  }));
  const result = { configured: true, whoami };
  if (whoami.status !== 200 || !whoami.username) return result;
  result.organization = await read('/-/org/clowder-ai/user', (body) => ({
    role: ['owner', 'admin', 'developer'].includes(body[whoami.username]) ? body[whoami.username] : 'not_listed',
  }));
  result.packages = await read('/-/org/clowder-ai/package', (body) => ({
    access: Object.fromEntries(Object.entries(body).filter(([name, access]) =>
      TARGETS.has(name) && ['read-only', 'read-write'].includes(access))),
  }));
  result.enterprise = await read('/@clowder-ai%2fenterprise-workflow', () => ({}));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.NPM_TOKEN;
  delete process.env.NPM_TOKEN;
  console.log(JSON.stringify(await inspectPublisher({ token })));
}
