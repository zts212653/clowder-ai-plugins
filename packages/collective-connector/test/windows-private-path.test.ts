import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { ConnectorPersistence } from '../src/business/connector/persistence.js';
import { GitHubAppManifestSetup } from '../src/business/service/github-app-manifest-setup.js';
import { ConfigurableGitHubHumanAuthProvider } from '../src/business/service/github-human-auth-provider.js';
import { CollectiveServiceStore } from '../src/business/service/index.js';
import { SERVICE_STATE_FILE } from '../src/business/service/persistence.js';
import { openCollectiveContextReferences } from '../src/collective-context-refs.js';
import { windowsPowerShell51Environment } from '../src/private-path-access.js';

const execFileAsync = promisify(execFile);

test(
  'Windows repairs an explicitly open child after the root is already private',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const directory = await privateFixture(t, 'collective-windows-service-');
    const first = await CollectiveServiceStore.open({ dataDirectory: directory });
    const existing = join(directory, 'preexisting-secret.json');
    await writeFile(existing, '{"secret":true}\n');
    await grantEveryoneExplicitRead(existing);
    assertPrivateAcl(await inspectAcl(directory), true);
    assert.equal(
      (await inspectAcl(existing)).rules.some((rule) => rule.sid === 'S-1-1-0'),
      true,
    );

    assert.equal(first.store.getMetadata().bootstrapNeeded, true);
    await CollectiveServiceStore.open({ dataDirectory: directory });

    assertPrivateAcl(await inspectAcl(directory), true);
    assertPrivateAcl(await inspectAcl(existing), true);
    assertPrivateAcl(await inspectAcl(join(directory, SERVICE_STATE_FILE)), false);
  },
);

test(
  'Windows GitHub App setup establishes and reopens the same private tree',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const directory = await privateFixture(t, 'collective-windows-github-app-');
    const setup = await GitHubAppManifestSetup.open({
      dataDirectory: directory,
      provider: new ConfigurableGitHubHumanAuthProvider({}),
      createSecret: () => 's'.repeat(43),
    });
    await setup.begin({
      serviceInstanceId: 'svc_windows_private_path',
      serviceUrl: 'http://127.0.0.1:5201',
      humanAuthCallbackUrl: 'http://127.0.0.1:5201/api/auth/github/callback',
      setupCallbackUrl: 'http://127.0.0.1:5201/api/setup/github-app/callback',
    });
    await GitHubAppManifestSetup.open({
      dataDirectory: directory,
      provider: new ConfigurableGitHubHumanAuthProvider({}),
    });
    assertPrivateAcl(await inspectAcl(directory), true);
    assertPrivateAcl(await inspectAcl(join(directory, 'github-app-setup.json')), false);
  },
);

test(
  'Windows refuses a junction before reading private state',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const directory = await privateFixture(t, 'collective-windows-junction-root-');
    const target = await privateFixture(t, 'collective-windows-junction-target-');
    await symlink(target, join(directory, 'outside'), 'junction');
    await rejectsWithDiagnostic(
      CollectiveServiceStore.open({ dataDirectory: directory }),
      /reparse point/i,
    );
  },
);

test(
  'Windows refuses an untrusted existing owner without adopting the tree',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const directory = await privateFixture(t, 'collective-windows-untrusted-owner-');
    const untrustedSid = 'S-1-5-19';
    if (!(await isElevated())) {
      t.skip('Changing owner requires an elevated Windows runner');
      return;
    }
    await setOwner(directory, untrustedSid);
    assert.equal((await inspectAcl(directory)).owner, untrustedSid);
    await rejectsWithDiagnostic(
      CollectiveServiceStore.open({ dataDirectory: directory }),
      /untrusted owner/i,
    );
    assert.equal((await inspectAcl(directory)).owner, untrustedSid);
  },
);

test(
  'Windows Connector and native-reference recovery share the same enforced DACL boundary',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const connectorDirectory = await privateFixture(t, 'collective-windows-connector-');
    await grantEveryoneRead(connectorDirectory);
    const connector = await ConnectorPersistence.open(connectorDirectory);
    await ConnectorPersistence.open(connectorDirectory);
    assertPrivateAcl(await inspectAcl(connectorDirectory), true);
    assertPrivateAcl(await inspectAcl(connector.filePath), false);

    const referenceDirectory = await privateFixture(t, 'collective-windows-reference-');
    await grantEveryoneRead(referenceDirectory);
    const first = await openCollectiveContextReferences(referenceDirectory, () => {});
    const expected = first.opaqueRef(
      { pluginInstanceId: 'windows-fixture', invocationId: 'first' },
      'context',
      'message:1',
    );
    const reopened = await openCollectiveContextReferences(referenceDirectory, () => {});
    assert.equal(
      reopened.opaqueRef({ pluginInstanceId: 'windows-fixture', invocationId: 'first' }, 'context', 'message:1'),
      expected,
    );
    assertPrivateAcl(await inspectAcl(referenceDirectory), true);
    assertPrivateAcl(await inspectAcl(join(referenceDirectory, 'native-reference.secret')), false);
  },
);

interface AclInspection {
  readonly owner: string;
  readonly current: string;
  readonly protected: boolean;
  readonly rules: readonly {
    readonly sid: string;
    readonly allow: boolean;
    readonly full: boolean;
  }[];
}

function assertPrivateAcl(inspection: AclInspection, requireProtected: boolean): void {
  assert.equal(inspection.owner, inspection.current);
  if (requireProtected) assert.equal(inspection.protected, true);
  assert.deepEqual(inspection.rules, [{ sid: inspection.current, allow: true, full: true }]);
}

async function privateFixture(t: { after(fn: () => Promise<void>): void }, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function grantEveryoneRead(path: string): Promise<void> {
  await execFileAsync('icacls.exe', [path, '/grant', '*S-1-1-0:(OI)(CI)R']);
}

async function grantEveryoneExplicitRead(path: string): Promise<void> {
  await execFileAsync('icacls.exe', [path, '/inheritance:d']);
  await execFileAsync('icacls.exe', [path, '/grant', '*S-1-1-0:R']);
}

async function setOwner(path: string, sid: string): Promise<void> {
  await execFileAsync('icacls.exe', [path, '/setowner', `*${sid}`]);
}

async function isElevated(): Promise<boolean> {
  const script = `
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
try {
  $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
  if ($principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 0 }
  exit 1
} finally { $identity.Dispose() }
`;
  const systemRoot = process.env.SystemRoot?.trim();
  assert.ok(systemRoot, 'Windows elevation probe requires SystemRoot');
  const executable = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    await execFileAsync(
      executable,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { env: windowsPowerShell51Environment() },
    );
    return true;
  } catch (error) {
    if ((error as { readonly code?: unknown }).code === 1) return false;
    throw error;
  }
}

async function rejectsWithDiagnostic(operation: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(operation, (error) => {
    assert.match(errorDiagnostic(error), pattern);
    return true;
  });
}

function errorDiagnostic(value: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = value;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message);
    const details = current as Error & { readonly cause?: unknown; readonly stderr?: unknown };
    if (typeof details.stderr === 'string') messages.push(details.stderr);
    if (Buffer.isBuffer(details.stderr)) messages.push(details.stderr.toString('utf8'));
    current = details.cause;
  }
  return messages.join('\n');
}

async function inspectAcl(path: string): Promise<AclInspection> {
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$path = [Environment]::GetEnvironmentVariable('CLOWDER_ACL_INSPECTION_PATH', 'Process')
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
try { $sid = $identity.User } finally { $identity.Dispose() }
$acl = Get-Acl -LiteralPath $path -ErrorAction Stop
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
  [PSCustomObject]@{
    sid = $_.IdentityReference.Value
    allow = $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow
    full = $_.FileSystemRights -eq [System.Security.AccessControl.FileSystemRights]::FullControl
  }
})
[PSCustomObject]@{
  owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  current = $sid.Value
  protected = $acl.AreAccessRulesProtected
  rules = [object[]] $rules
} | ConvertTo-Json -Compress -Depth 4
`;
  const systemRoot = process.env.SystemRoot?.trim();
  assert.ok(systemRoot, 'Windows ACL inspection requires SystemRoot');
  const executable = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await execFileAsync(
    executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    {
      env: windowsPowerShell51Environment({ CLOWDER_ACL_INSPECTION_PATH: path }),
      windowsHide: true,
    },
  );
  const parsed: unknown = JSON.parse(stdout);
  assert.equal(typeof parsed, 'object');
  assert.notEqual(parsed, null);
  const candidate = parsed as Partial<AclInspection>;
  assert.equal(typeof candidate.owner, 'string');
  assert.equal(typeof candidate.current, 'string');
  assert.equal(typeof candidate.protected, 'boolean');
  assert.equal(Array.isArray(candidate.rules), true);
  return candidate as AclInspection;
}
