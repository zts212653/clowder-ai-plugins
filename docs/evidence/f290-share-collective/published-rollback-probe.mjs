// Reproducible rollback evidence, adapted from Sonnet's independent review probe.
// Run after building the current Collective package; all identities and state are synthetic.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = process.env.F290_NEW_PACKAGE_ROOT;
const serviceDir = packageRoot
  ? pathToFileURL(`${resolve(packageRoot, 'dist/business/service')}${sep}`)
  : new URL('../../../packages/collective-connector/dist/business/service/', import.meta.url);
if (packageRoot) {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  console.log(`Testing candidate package ${manifest.name}@${manifest.version}`);
}
const { CollectiveServiceStore: NewStore } = await import(new URL('store.js', serviceDir));
const { prepareInviteRollback, restoreInviteMetadata } = await import(new URL('invite-rollback.js', serviceDir));

const provider = {
  id: 'github',
  readiness: { ready: true },
  authorizationUrl: ({ state }) => `https://github.test/authorize?state=${encodeURIComponent(state)}`,
  authenticate: async ({ code }) => ({
    providerSubject: code, handle: code, displayName: code === 'owner' ? 'Owner' : code,
  }),
};
const temp = await mkdtemp(join(tmpdir(), 'f290-published-rollback-'));
let checks = 0;

function checked(description, condition) {
  assert.ok(condition, description);
  checks++;
  console.log(`PASS ${description}`);
}

async function joinCollective(store, inviteToken, code) {
  const attempt = await store.beginHumanAuth({ provider: 'github', intent: { kind: 'accept_invite', inviteToken } });
  const done = await store.completeHumanAuth({ provider: 'github', state: attempt.state, code });
  return store.exchangeHumanAuthCompletion(done.completionToken);
}

async function seed(dataDirectory) {
  const opened = await NewStore.open({ dataDirectory, humanAuthProvider: provider });
  assert.ok(opened.bootstrapSecret, 'fresh synthetic Service must provide a bootstrap secret');
  const store = opened.store;
  const owner = await store.consumeBootstrap({ secret: opened.bootstrapSecret, displayName: 'Owner' });
  const bind = await store.beginHumanAuth({ provider: 'github', intent: { kind: 'bind' }, sessionToken: owner.sessionToken });
  const bound = await store.completeHumanAuth({ provider: 'github', state: bind.state, code: 'owner' });
  await store.exchangeHumanAuthCompletion(bound.completionToken);
  const collective = await store.createCollective({ sessionToken: owner.sessionToken, name: 'Probe Collective' });
  const collectiveId = collective.collectiveId;
  const create = () => store.createInvite({ sessionToken: owner.sessionToken, collectiveId });
  const ready = await create();
  const revoked = await create();
  await store.revokeInvite({ sessionToken: owner.sessionToken, collectiveId, inviteId: revoked.inviteId });
  const used = await create();
  await joinCollective(store, used.inviteToken, 'earlyfriend');
  return { owner, collectiveId, ready, revoked, used };
}

async function verifyTarget(version) {
  const label = `alpha.${version}`;
  const target = `0.1.0-${label}`;
  const installDir = join(temp, label, 'installed');
  await mkdir(installDir, { recursive: true, mode: 0o700 });
  // Install the actual immutable published package; do not execute package install scripts.
  execFileSync('npm', [
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', installDir,
    `@clowder-ai/collective-connector@${target}`,
  ], { stdio: 'pipe' });
  const packageDir = join(installDir, 'node_modules', '@clowder-ai', 'collective-connector');
  const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  checked(`${label}: installed the requested published package`, manifest.version === target);
  const oldStoreUrl = pathToFileURL(join(packageDir, 'dist/business/service/store.js')).href;
  const { CollectiveServiceStore: OldStore } = await import(oldStoreUrl);

  const base = join(temp, label, 'data');
  const rawDir = join(base, 'raw');
  const seeded = await seed(rawDir);
  const rawText = await readFile(join(rawDir, 'collective-service.json'), 'utf8');
  const rawState = JSON.parse(rawText);
  const invitations = Object.values(rawState.invites);
  checked(`${label}: new state contains inviter and revocation metadata`,
    invitations.some((invite) => invite.createdByHumanId) && invitations.some((invite) => invite.revokedAt));

  const unconvertedDir = join(base, 'unconverted');
  await cp(rawDir, unconvertedDir, { recursive: true });
  await assert.rejects(OldStore.open({ dataDirectory: unconvertedDir, humanAuthProvider: provider }), { code: 'STATE_CORRUPT' });
  checked(`${label}: old package rejects unconverted state without modifying it`,
    await readFile(join(unconvertedDir, 'collective-service.json'), 'utf8') === rawText);

  const prepared = prepareInviteRollback(rawState, target);
  const convertedDir = join(base, 'converted');
  await cp(rawDir, convertedDir, { recursive: true });
  await writeFile(join(convertedDir, 'collective-service.json'), `${JSON.stringify(prepared.state)}\n`);
  const old = (await OldStore.open({ dataDirectory: convertedDir, humanAuthProvider: provider })).store;
  checked(`${label}: old package opens the converted state`, true);
  for (const [name, invitation] of [['revoked', seeded.revoked], ['used', seeded.used]]) {
    await assert.rejects(old.beginHumanAuth({
      provider: 'github', intent: { kind: 'accept_invite', inviteToken: invitation.inviteToken },
    }), { code: 'INVITE_INVALID' });
    checked(`${label}: ${name} invitation cannot start acceptance`, true);
  }
  const friend = await joinCollective(old, seeded.ready.inviteToken, 'latefriend');
  checked(`${label}: a ready invitation joins the original Collective`,
    (await old.listCollectives(friend.sessionToken)).some((item) => item.collectiveId === seeded.collectiveId));
  const oldMade = await old.createInvite({ sessionToken: seeded.owner.sessionToken, collectiveId: seeded.collectiveId });

  const advanced = JSON.parse(await readFile(join(convertedDir, 'collective-service.json'), 'utf8'));
  const restored = restoreInviteMetadata(advanced, prepared.metadata);
  const forwardDir = join(base, 'forward');
  await mkdir(forwardDir, { recursive: true, mode: 0o700 });
  await writeFile(join(forwardDir, 'collective-service.json'), `${JSON.stringify(restored)}\n`);
  const forward = (await NewStore.open({ dataDirectory: forwardDir, humanAuthProvider: provider })).store;
  const revoked = forward.previewInvite(seeded.revoked.inviteToken);
  checked(`${label}: restored revoked invitation previews as revoked`, revoked.status === 'revoked');
  checked(`${label}: invitation consumed while rolled back previews as used`,
    forward.previewInvite(seeded.ready.inviteToken).status === 'used');
  checked(`${label}: inviter metadata survives rollback`,
    forward.previewInvite(seeded.ready.inviteToken).inviter?.displayName === 'Owner');
  const oldMadePreview = forward.previewInvite(oldMade.inviteToken);
  checked(`${label}: old-version invitation stays ready without an invented inviter`,
    oldMadePreview.status === 'ready' && oldMadePreview.inviter === null);
  checked(`${label}: member who joined during rollback remains a member`,
    (await forward.listCollectives(friend.sessionToken)).some((item) => item.collectiveId === seeded.collectiveId));
  const revokeAgain = await forward.revokeInvite({
    sessionToken: seeded.owner.sessionToken, collectiveId: seeded.collectiveId, inviteId: seeded.revoked.inviteId,
  });
  checked(`${label}: repeated revoke reports revoked after restoring metadata`, revokeAgain.status === 'revoked');
  await assert.rejects(forward.beginHumanAuth({
    provider: 'github', intent: { kind: 'accept_invite', inviteToken: seeded.revoked.inviteToken },
  }), { code: 'INVITE_INVALID' });
  checked(`${label}: restored revoked invitation remains unusable`, true);
}

try {
  await verifyTarget('22');
  await verifyTarget('24');
  console.log(`PASS ${checks}/${checks} published-package rollback checks`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
