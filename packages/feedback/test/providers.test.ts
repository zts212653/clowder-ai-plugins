import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { attachments } from '../src/attachments.js';
import { defaultProfiles, parseProfiles } from '../src/config.js';
import { marker, provider } from '../src/providers.js';
import type { Host, Profile } from '../src/types.js';
import { pngFixture } from './png-fixture.js';

const signal = new AbortController().signal;
const host = { secrets: { get: async () => 'test-only-token' } } as Host;
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const image = pngFixture();

test('GitHub validates principal/project/visibility and returns server Issue URL with Chinese readback', async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const target = defaultProfiles[0]!;
  const remote = { number: 15, html_url: 'https://github.com/zts212653/clowder-ai/issues/15', title: '中文问题', body: `中文报告\n\n${marker('fixture')}` };
  const transport: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return json(String(url).endsWith('/user') ? { login: 'fixture-owner' } : String(url).endsWith('/issues') || String(url).endsWith('/issues/15') ? remote : { full_name: target.project, private: false, has_issues: true });
  };
  const adapter = provider(host, target, transport);
  assert.equal((await adapter.preflight(signal)).principal, 'fixture-owner');
  const created = await adapter.create({ title: '中文问题', body: '中文报告', attachments: [] }, 'fixture', signal);
  assert.equal(created.url, remote.html_url);
  assert.deepEqual(await adapter.read(created, signal), created);
  assert.equal(JSON.parse(String(requests.find(r => r.init?.method === 'POST')?.init?.body)).title, '中文问题');
  assert.ok(requests.every(r => r.init?.redirect === 'error'));
});

test('GitLab uploads approved binary, verifies bytes, then links it in report', async () => {
  const target: Profile = { ...defaultProfiles[0]!, provider: 'gitlab', tokenRef: 'gitlabToken', apiBaseUrl: 'https://gitlab.example.test/api/v4', issueCreateUrl: 'https://gitlab.example.test/group/project/-/issues/new', project: 'group/project', visibility: 'private' };
  let upload: FormData | undefined;
  const adapter = provider(host, target, async (url, init) => {
    if (init?.body instanceof FormData) { upload = init.body; return json({ full_path: '/group/project/uploads/secret/screenshot-1.png' }); }
    if (String(url).includes('/uploads/')) return new Response(image);
    return json({ username: 'owner', path_with_namespace: 'group/project', visibility: 'private', issues_enabled: true });
  });
  const picture = attachments([{ mime: 'image/png', base64: image.toString('base64') }])[0]!;
  assert.equal(picture.sha256, createHash('sha256').update(image).digest('hex'));
  assert.equal((await adapter.preflight(signal)).attachments, true);
  const markdown = await adapter.upload(picture, 'fixture', signal);
  assert.match(markdown, /https:\/\/gitlab.example.test\/group\/project\/uploads\//);
  assert.deepEqual(Buffer.from(await (upload!.get('file') as File).arrayBuffer()), image);
});

test('rejects mismatched targets, credentials in manual URL, remote link substitution and fake images', async () => {
  assert.throws(() => parseProfiles([{ ...defaultProfiles[0], issueCreateUrl: 'https://github.com/other/repo/issues/new' }]), /不匹配/);
  assert.throws(() => parseProfiles([{ ...defaultProfiles[0], issueCreateUrl: 'https://secret@github.com/zts212653/clowder-ai/issues/new?body=private' }]), /认证信息/);
  assert.throws(() => attachments([{ mime: 'image/png', base64: Buffer.from('<svg onload="alert(1)">').toString('base64') }]), /实际/);
  const adapter = provider(host, defaultProfiles[0]!, async () => json({ number: 2, html_url: 'https://evil.example.test/zts212653/clowder-ai/issues/2', title: 'x', body: 'x' }));
  await assert.rejects(adapter.create({ title: 'x', body: 'x', attachments: [] }, 'fixture', signal), /不匹配/);
});
