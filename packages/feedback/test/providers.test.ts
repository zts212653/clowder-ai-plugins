import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { attachments } from '../src/attachments.js';
import { CliUnavailableError } from '../src/cli.js';
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

test('a logged-in GitHub CLI can supply the GitHub.com credential, without retrying a write', async () => {
  const target = defaultProfiles[0]!;
  const seen: string[] = [];
  let cliReads = 0;
  let creates = 0;
  const adapter = provider(host, target, async (url, init) => {
    const credential = new Headers(init?.headers).get('authorization') ?? '';
    assert.equal(new URL(String(url)).origin, 'https://api.github.com');
    seen.push(credential);
    if (init?.method === 'POST') {
      creates++;
      return new Response('', {status:401});
    }
    if (credential === 'Bearer test-only-token') return new Response('', {status:401});
    return json(String(url).endsWith('/user') ? {login:'local-cli'} : {full_name:target.project, private:false});
  }, async () => { cliReads++; return 'synthetic-gh-credential'; });
  assert.deepEqual(await adapter.preflight(signal), {principal:'local-cli',visibility:'public',attachments:false,githubAuth:'cli'});
  await assert.rejects(adapter.create({title:'fixture',body:'fixture',attachments:[]}, 'test', signal),
    {code:'feedback_token_invalid',githubCli:'rejected'});
  assert.equal(creates,1);
  assert.equal(cliReads,1);
  assert.deepEqual(seen,['Bearer test-only-token','Bearer synthetic-gh-credential','Bearer synthetic-gh-credential','Bearer synthetic-gh-credential']);
});

test('missing CLI and missing login have distinct guidance, and other origins cannot use the GitHub.com login', async () => {
  const target = defaultProfiles[0]!;
  const noToken = { secrets:{ get:async()=>undefined } } as Host;
  const fetcher: typeof fetch = async () => assert.fail('No network request should be made without an approved credential');
  await assert.rejects(provider(noToken,target,fetcher,async()=>{throw new CliUnavailableError();}).preflight(signal),
    {code:'feedback_token_missing',githubCli:'unavailable'});
  await assert.rejects(provider(noToken,target,fetcher,async()=>{throw new Error();}).preflight(signal),
    {code:'feedback_token_missing',githubCli:'login'});
  const enterprise = {...target, apiBaseUrl:'https://git.example.test/api/v3', issueCreateUrl:'https://git.example.test/a/b/issues/new'};
  await assert.rejects(provider(noToken,enterprise,fetcher,async()=>assert.fail('CLI login is limited to GitHub.com')).preflight(signal),
    {code:'feedback_token_missing',githubCli:undefined});
});

test('GitHub CLI attachments require push permission and confirm a comment on the exact Issue', async () => {
  const target = defaultProfiles[0]!;
  const issue = { id:'5', url:'https://github.com/zts212653/clowder-ai/issues/5', title:'fixture', body:'fixture' };
  const picture = attachments([{mime:'image/png',base64:image.toString('base64')}])[0]!;
  let push = false;
  let partial = false;
  let help = 0;
  let comments = 0;
  const commentUrl = issue.url+'#issuecomment-41';
  const adapter = provider(host, target, async url => {
    if (String(url).endsWith('/user')) return json({login:'owner'});
    if (String(url).endsWith('/issues/comments/41')) return json({html_url:commentUrl,
      body:partial ? '<!-- clowder-screenshots:my-id -->' : '截图\n\n<!-- clowder-screenshots:my-id -->\n\n![Clowder-screenshot-1](https://github.com/user-attachments/assets/test)'});
    return json({full_name:target.project,private:false,permissions:{push}});
  }, async () => assert.fail('configured token is sufficient'),
  async () => { help++; return true; },
  async (url, pictures, body, auth) => {
    assert.equal(url,issue.url);
    assert.deepEqual(pictures,[picture]);
    assert.match(body,/clowder-screenshots:my-id/);
    assert.equal(auth,'test-only-token');
    comments++;
    return commentUrl;
  });
  assert.equal((await adapter.preflight(signal,true)).githubCliAttachments,undefined);
  assert.equal(help,0);
  push = true;
  assert.equal((await adapter.preflight(signal,true)).githubCliAttachments,true);
  assert.equal(help,1);
  assert.deepEqual(await adapter.attachToIssue!(issue,[picture],'my-id',signal),[picture.sha256]);
  partial = true;
  assert.deepEqual(await adapter.attachToIssue!(issue,[picture],'my-id',signal),[]);
  assert.equal(comments,2);
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
