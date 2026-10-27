import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { participationFixture } from '../src/business/service/__tests__/participation-fixture.ts';
import { ConfigurableGitHubHumanAuthProvider } from '../src/business/service/github-human-auth-provider.ts';
import { GitHubAppManifestSetup } from '../src/business/service/github-app-manifest-setup.ts';
import { fixture as publicSourceFixture } from '../src/business/connector/__tests__/communication-work-custody.fixture.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const runtimeRoot = process.env.F290_INSTALLED_PACKAGE_ROOT ?? root;
assert.ok(isAbsolute(runtimeRoot));
const launcher =
  runtimeRoot === root ? ['--import', 'tsx', 'src/business/service/cli.ts'] : ['dist/business/service/cli.js'];

test('help is side-effect free even when the saved listener configuration is unusable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collective-cli-help-'));
  try {
    const result = spawnSync(process.execPath, [...launcher, '--help'], {
      cwd: runtimeRoot,
      env: { PATH: process.env.PATH, COLLECTIVE_SERVICE_PORT: '3001', COLLECTIVE_SERVICE_DATA_DIR: directory },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /COLLECTIVE_SERVICE_PUBLIC_URL/);
    await assert.rejects(readFile(join(directory, 'collective-service.json')), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function launch(dataDirectory, environment = {}) {
  const child = spawn(process.execPath, launcher, {
    cwd: runtimeRoot,
    env: {
      PATH: process.env.PATH,
      COLLECTIVE_SERVICE_DATA_DIR: dataDirectory,
      COLLECTIVE_SERVICE_HOST: '127.0.0.1',
      COLLECTIVE_SERVICE_PORT: '0',
      COLLECTIVE_SERVICE_PUBLIC_URL: 'http://127.0.0.1:15201',
      ...environment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (text) => {
    stderr += text;
  });
  const exited = once(child, 'exit');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    clearTimeout(timeout);
  };
  try {
    let output = '';
    const ready = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => reject(new Error(`Service exited before ready: ${stderr}`)));
      child.stdout.setEncoding('utf8').on('data', (text) => {
        output += text;
        if (output.includes('\n')) {
          const event = JSON.parse(output.split('\n')[0]);
          if (event.event === 'collective-service-ready') resolve(event);
        }
      });
    });
    return { ready, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

test(
  'the installed CLI uses only its explicitly configured, identity-matched local speech service',
  {
    skip: ['ffmpeg', 'ffprobe'].some((tool) => spawnSync(tool, ['-version'], { stdio: 'ignore' }).status !== 0),
  },
  async () => {
    const f = await publicSourceFixture();
    let running,
      identity = 'whisper-fixture',
      uploads = 0;
    const speech = createServer(async (request, response) => {
      if (request.url === '/health') {
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ status: 'ok', model: identity, backend: 'faster-whisper' }));
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const form = await new Response(Buffer.concat(chunks), {
        headers: { 'content-type': request.headers['content-type'] },
      }).formData();
      assert.equal(form.get('model'), 'whisper-fixture');
      assert.ok(form.get('file') instanceof File && form.get('file').size > 44);
      uploads++;
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ text: '明确的转写夹具，真实音频传输。' }));
    });
    try {
      await new Promise((resolve) => speech.listen(0, '127.0.0.1', resolve));
      const origin = f.server.url;
      await f.server.close();
      running = await launch(join(f.root, 'service'), {
        COLLECTIVE_SERVICE_PORT: new URL(origin).port,
        COLLECTIVE_SERVICE_PUBLIC_URL: origin,
        COLLECTIVE_STT_URL: `http://127.0.0.1:${speech.address().port}`,
        COLLECTIVE_STT_MODEL: 'whisper-fixture',
      });
      const bytes = spawnSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=0.25',
          '-ar',
          '16000',
          '-ac',
          '1',
          '-f',
          'wav',
          'pipe:1',
        ],
        { maxBuffer: 1024 * 1024 },
      );
      assert.equal(bytes.status, 0, String(bytes.stderr));
      const coordinates = {
        serviceInstanceId: f.connection.serviceInstanceId,
        collectiveId: f.connection.collectiveId,
      };
      const headers = { authorization: `Bearer ${f.owner.sessionToken}`, 'content-type': 'application/json' };
      const query = new URLSearchParams({
        ...coordinates,
        channelId: 'general',
        clientUploadId: 'configured-speech',
        fileName: 'voice.wav',
        mediaType: 'audio/wav',
        blobDigest: `sha256:${createHash('sha256').update(bytes.stdout).digest('hex')}`,
      });
      const upload = await fetch(`${origin}/api/message-attachments/upload?${query}`, {
        method: 'POST',
        headers,
        body: bytes.stdout,
      });
      assert.equal(upload.status, 201);
      const attachment = await upload.json();
      const sent = await fetch(`${origin}/api/events/human`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...coordinates,
          clientEventId: 'published-configured-speech',
          location: { channelId: 'general' },
          recipient: { kind: 'channel' },
          body: '',
          attachments: [attachment],
        }),
      });
      assert.equal(sent.status, 201);
      const event = await sent.json();
      const read = () =>
        f.connector.readParticipationMedia(f.source, { eventId: event.eventId, attachmentId: attachment.attachmentId });
      const content = await read();
      assert.equal(content.content.type, 'audio');
      assert.equal(content.content.transcript, '明确的转写夹具，真实音频传输。');
      assert.equal(content.sourceDigest, attachment.blobDigest);
      assert.equal(uploads, 1);
      identity = 'another-model';
      assert.deepEqual((await read()).content, { type: 'unavailable', reason: 'transcription_unavailable' });
      assert.equal(uploads, 1, 'a different local model receives no audio');
    } finally {
      await running?.stop();
      await new Promise((resolve) => {
        speech.close(resolve);
        speech.closeAllConnections();
      });
      await f.close();
    }
  },
);

test('standalone entry serves the same Client and recovers the unclaimed bootstrap across restart', async () => {
  const data = await mkdtemp(join(tmpdir(), 'collective-standalone-'));
  let running;
  try {
    running = await launch(data);
    const first = running.ready;
    const page = await fetch(first.listenUrl ?? first.url);
    assert.equal(page.status, 200, 'the supported standalone entry must serve the packaged Client');
    assert.match(await page.text(), /collective-client\/app\.js/);
    const bootstrap = await readFile(first.bootstrapLinkPath, 'utf8');
    assert.match(bootstrap, /^http:\/\/127\.0\.0\.1:15201\/#bootstrap=/);
    assert.equal((await stat(first.bootstrapLinkPath)).mode & 0o777, 0o600);
    await running.stop();
    running = await launch(data);
    assert.equal(running.ready.serviceInstanceId, first.serviceInstanceId);
    assert.equal(await readFile(running.ready.bootstrapLinkPath, 'utf8'), bootstrap);
    const result = await fetch(`${running.ready.listenUrl ?? running.ready.url}/api/bootstrap`, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:15201', 'content-type': 'application/json' },
      body: JSON.stringify({
        secret: new URLSearchParams(new URL(bootstrap.trim()).hash.slice(1)).get('bootstrap'),
        displayName: 'Owner',
      }),
    });
    assert.equal(result.status, 201);
    await running.stop();
    running = await launch(data);
    assert.equal(running.ready.serviceInstanceId, first.serviceInstanceId);
    assert.equal(running.ready.bootstrapLinkPath, undefined);
    await assert.rejects(readFile(join(data, 'owner-bootstrap.secret')), { code: 'ENOENT' });
  } finally {
    await running?.stop();
    await rm(data, { recursive: true, force: true });
  }
});

test('independent Service retains member attachments through restart, ranges, retries and revocation', async () => {
  const data = await mkdtemp(join(tmpdir(), 'collective-standalone-content-'));
  const backup = await mkdtemp(join(tmpdir(), 'collective-standalone-restored-'));
  let running;
  try {
    const f = await participationFixture(data);
    const invite = await f.store.createInvite({
      sessionToken: f.owner.sessionToken,
      collectiveId: f.coordinates.collectiveId,
    });
    const attempt = await f.store.beginHumanAuth({
      provider: 'github',
      intent: { kind: 'accept_invite', inviteToken: invite.inviteToken },
    });
    const completion = await f.store.completeHumanAuth({ provider: 'github', state: attempt.state, code: 'member' });
    const member = await f.store.exchangeHumanAuthCompletion(completion.completionToken);
    const provider = new ConfigurableGitHubHumanAuthProvider({});
    const setup = await GitHubAppManifestSetup.open({
      dataDirectory: data,
      provider,
      fetchImpl: async () => Response.json({ id: 1, client_id: 'fixture-id', client_secret: 'fixture-secret' }),
    });
    const begin = await setup.begin({
      serviceInstanceId: f.coordinates.serviceInstanceId,
      serviceUrl: 'http://127.0.0.1:15201',
      humanAuthCallbackUrl: 'http://127.0.0.1:15201/api/auth/github/callback',
      setupCallbackUrl: 'http://127.0.0.1:15201/api/setup/github-app/callback',
    });
    await setup.complete({ state: new URL(begin.registrationUrl).searchParams.get('state'), code: 'fixture' });
    running = await launch(data);
    const request = async (path, token, body, headers = {}) =>
      fetch(`${running.ready.listenUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
        body: body instanceof Buffer ? body : JSON.stringify(body),
      });
    const bytes = Buffer.from('member-owned ordinary attachment');
    const query = new URLSearchParams({
      ...f.coordinates,
      channelId: 'general',
      clientUploadId: 'same-upload',
      fileName: 'notes.txt',
      mediaType: 'text/plain',
      blobDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    });
    const upload = () => request(`/api/message-attachments/upload?${query}`, member.sessionToken, bytes);
    const retained = await upload();
    assert.equal(retained.status, 201, 'independent installs need their own durable attachment custodian');
    const attachment = await retained.json();
    assert.deepEqual(await (await upload()).json(), attachment);
    const readQuery = new URLSearchParams({ ...f.coordinates, attachmentId: attachment.attachmentId });
    const read = (token, headers) => request(`/api/message-attachments/read?${readQuery}`, token, {}, headers);
    assert.equal((await read(f.owner.sessionToken)).status, 403, 'an unshared upload is private');
    const draft = {
      ...f.coordinates,
      clientEventId: 'same-published-file',
      location: { channelId: 'general' },
      recipient: { kind: 'channel' },
      body: '',
      attachments: [attachment],
    };
    const sent = await request('/api/events/human', member.sessionToken, draft);
    assert.equal(sent.status, 201);
    const event = await sent.json();
    readQuery.set('sourceEventId', event.eventId);
    assert.equal(
      (await (await request('/api/events/human', member.sessionToken, draft)).json()).eventId,
      event.eventId,
    );
    assert.equal(await (await read(f.owner.sessionToken)).text(), bytes.toString());
    await running.stop();
    running = await launch(data);
    assert.equal(running.ready.serviceInstanceId, f.coordinates.serviceInstanceId);
    assert.deepEqual(await (await upload()).json(), attachment, 'retry retains the exact owner receipt after restart');
    const partial = await read(f.owner.sessionToken, { range: 'bytes=7-11' });
    assert.equal(partial.status, 206);
    assert.equal(await partial.text(), bytes.subarray(7, 12).toString());
    assert.equal((await read(f.owner.sessionToken, { range: 'bytes=1000-' })).status, 416);
    await running.stop();
    const restored = join(backup, 'service');
    await cp(data, restored, { recursive: true });
    running = await launch(restored);
    assert.equal(running.ready.serviceInstanceId, f.coordinates.serviceInstanceId);
    const providers = await (await fetch(`${running.ready.listenUrl}/api/auth/providers`)).json();
    assert.equal(
      providers.providers.find((item) => item.id === 'github').ready,
      true,
      'provider credentials restore from the copied private directory',
    );
    assert.equal((await stat(join(restored, 'github-app-oauth.json'))).mode & 0o777, 0o600);
    assert.equal(
      await (await read(f.owner.sessionToken)).text(),
      bytes.toString(),
      'backup restores the ordinary original bytes and authorization',
    );
    const left = await request('/api/memberships/self-leave', member.sessionToken, {
      collectiveId: f.coordinates.collectiveId,
    });
    assert.equal(left.status, 200);
    assert.equal((await read(member.sessionToken)).status, 403);
    assert.equal(await (await read(f.owner.sessionToken)).text(), bytes.toString());
  } finally {
    await running?.stop();
    await rm(data, { recursive: true, force: true });
    await rm(backup, { recursive: true, force: true });
  }
});
