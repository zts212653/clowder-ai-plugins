import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

interface PrivateAccessMetadata {
  readonly mode: number | bigint;
  readonly uid: number | bigint;
}

export interface PrivateAccessErrors {
  readonly owner: string;
  readonly mode: string;
}

export interface PrivatePathBoundary {
  assertMetadata(metadata: PrivateAccessMetadata, errors: PrivateAccessErrors): void;
}

const execFileAsync = promisify(execFile);

/**
 * Build the environment for a Windows PowerShell 5.1 child process.
 *
 * When pwsh launches Node and Node then launches powershell.exe, Node is an intermediate process:
 * the PowerShell 7 PSModulePath would otherwise survive unchanged and can make 5.1 resolve an
 * incompatible system module. Removing the key lets Windows PowerShell construct its own defaults.
 * See Microsoft about_PSModulePath, “Starting Windows PowerShell from PowerShell 7”.
 */
export function windowsPowerShell51Environment(
  overrides: NodeJS.ProcessEnv = {},
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const source of [inheritedEnvironment, overrides]) {
    for (const [key, value] of Object.entries(source)) {
      if (key.toUpperCase() === 'PSMODULEPATH' || value === undefined) continue;
      environment[key] = value;
    }
  }
  return environment;
}

// Windows PowerShell 5.1 ships with supported Windows desktop releases. This fixed script never
// interpolates the target path: the child receives it through a process-scoped environment value.
const WINDOWS_PRIVATE_TREE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$rootPath = [Environment]::GetEnvironmentVariable('CLOWDER_COLLECTIVE_PRIVATE_ROOT', 'Process')
if ([String]::IsNullOrWhiteSpace($rootPath)) { throw 'Private root was not provided' }
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
try { $currentSid = $identity.User } finally { $identity.Dispose() }
if ($null -eq $currentSid) { throw 'Current Windows user has no SID' }
$trustedOwnerSids = @(
  $currentSid.Value,
  'S-1-5-32-544', # BUILTIN\Administrators can own files created by an elevated process.
  'S-1-5-18'      # LocalSystem can own provisioned service files.
)

function Assert-NotReparsePoint([System.IO.FileSystemInfo] $item) {
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw ('Private tree contains a reparse point: ' + $item.FullName)
  }
}

function New-PrivateRule([bool] $isDirectory) {
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
  if ($isDirectory) {
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  }
  return [System.Security.AccessControl.FileSystemAccessRule]::new(
    $currentSid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
}

function Get-TrustedPrivateAcl([System.IO.FileSystemInfo] $item) {
  Assert-NotReparsePoint $item
  $acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
  if ($trustedOwnerSids -notcontains $owner.Value) {
    throw ('Private tree item has an untrusted owner ' + $owner.Value + ': ' + $item.FullName)
  }
  return $acl
}

function Set-PrivateAcl([System.IO.FileSystemInfo] $item) {
  $acl = Get-TrustedPrivateAcl $item
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))) {
    [void] $acl.RemoveAccessRuleSpecific([System.Security.AccessControl.FileSystemAccessRule] $rule)
  }
  if (-not $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Equals($currentSid)) {
    $acl.SetOwner($currentSid)
  }
  [void] $acl.AddAccessRule((New-PrivateRule ($item -is [System.IO.DirectoryInfo])))
  Set-Acl -LiteralPath $item.FullName -AclObject $acl -ErrorAction Stop
}

function Test-PrivateAcl([System.IO.FileSystemInfo] $item, [bool] $requireProtected) {
  $acl = Get-TrustedPrivateAcl $item
  if ($requireProtected -and -not $acl.AreAccessRulesProtected) { return $false }
  if (-not $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Equals($currentSid)) { return $false }
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 1) { return $false }
  $rule = $rules[0]
  $expectedInheritance = [System.Security.AccessControl.InheritanceFlags]::None
  if ($item -is [System.IO.DirectoryInfo]) {
    $expectedInheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  }
  return (
    (-not $requireProtected -or -not $rule.IsInherited) -and
    $rule.IdentityReference.Equals($currentSid) -and
    $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
    $rule.FileSystemRights -eq [System.Security.AccessControl.FileSystemRights]::FullControl -and
    $rule.InheritanceFlags -eq $expectedInheritance -and
    $rule.PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None
  )
}

function Get-PrivateDescendants([System.IO.DirectoryInfo] $root) {
  $items = [System.Collections.Generic.List[System.IO.FileSystemInfo]]::new()
  $pending = [System.Collections.Generic.Stack[System.IO.DirectoryInfo]]::new()
  $pending.Push($root)
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    foreach ($child in $directory.EnumerateFileSystemInfos()) {
      Assert-NotReparsePoint $child
      $items.Add($child)
      if ($child -is [System.IO.DirectoryInfo]) { $pending.Push($child) }
    }
  }
  return $items.ToArray()
}

$root = Get-Item -Force -LiteralPath $rootPath -ErrorAction Stop
if (-not ($root -is [System.IO.DirectoryInfo])) { throw 'Private root is not a directory' }
Assert-NotReparsePoint $root
$descendants = @(Get-PrivateDescendants $root)
# Validate every existing owner before the first ACL mutation. A later per-item
# recheck in Set/Test closes the ordinary replacement window; an untrusted tree
# is rejected without adopting its pre-existing secrets or state.
[void] (Get-TrustedPrivateAcl $root)
foreach ($item in $descendants) { [void] (Get-TrustedPrivateAcl $item) }
$unsafeDescendants = @($descendants | Where-Object { -not (Test-PrivateAcl $_ $false) })
if ((Test-PrivateAcl $root $true) -and $unsafeDescendants.Count -eq 0) { exit 0 }

# Protect the root first so another principal cannot add a broad child during migration. Every
# startup still inspects descendants, so a crash cannot turn a root-only update into false trust.
Set-PrivateAcl $root
$settled = $false
for ($attempt = 0; $attempt -lt 3; $attempt++) {
  $remaining = @((Get-PrivateDescendants $root) | Where-Object { -not (Test-PrivateAcl $_ $false) })
  foreach ($item in $remaining) { Set-PrivateAcl $item }
  $remaining = @((Get-PrivateDescendants $root) | Where-Object { -not (Test-PrivateAcl $_ $false) })
  if ($remaining.Count -eq 0) { $settled = $true; break }
}
if (-not $settled) { throw 'Private tree changed while its ACL was being established' }
if (-not (Test-PrivateAcl $root $true)) { throw 'Private root ACL verification failed' }
foreach ($item in @(Get-PrivateDescendants $root)) {
  if (-not (Test-PrivateAcl $item $false)) { throw ('Private child ACL verification failed: ' + $item.FullName) }
}
`;

/** Establish the platform privacy boundary before any state or secret is read. */
export async function establishPrivateDirectoryAccess(path: string): Promise<PrivatePathBoundary> {
  return establishPrivateDirectoryAccessForPlatform(path, process.platform, protectWindowsPrivateTree);
}

/** Package-private seam for platform policy tests; public consumers cannot import internal subpaths. */
export async function establishPrivateDirectoryAccessForPlatform(
  path: string,
  platform: NodeJS.Platform,
  protectWindowsTree: (path: string) => Promise<void>,
): Promise<PrivatePathBoundary> {
  const canonicalPath = resolve(path);
  const metadata = await lstat(canonicalPath);
  if (!metadata.isDirectory()) throw new Error('Collective private data root must be a regular directory');
  if (platform === 'win32') {
    await protectWindowsTree(canonicalPath);
  } else {
    assertPrivatePosixAccess(metadata, {
      owner: 'Collective private data root must be owned by the current user',
      mode: 'Collective private data root permissions must be private (mode 0700)',
    });
  }
  return Object.freeze({
    assertMetadata(metadata: PrivateAccessMetadata, errors: PrivateAccessErrors) {
      if (platform !== 'win32') assertPrivatePosixAccess(metadata, errors);
    },
  });
}

async function protectWindowsPrivateTree(path: string): Promise<void> {
  const systemRoot = process.env.SystemRoot?.trim();
  if (!systemRoot) throw new Error('Collective Windows private-path ACL requires SystemRoot');
  const executable = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    await execFileAsync(
      executable,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(WINDOWS_PRIVATE_TREE_SCRIPT, 'utf16le').toString('base64'),
      ],
      {
        env: windowsPowerShell51Environment({ CLOWDER_COLLECTIVE_PRIVATE_ROOT: path }),
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
      },
    );
  } catch (error) {
    throw new Error('Collective Windows private-path ACL could not be established', { cause: error });
  }
}

function assertPrivatePosixAccess(metadata: PrivateAccessMetadata, errors: PrivateAccessErrors): void {
  const uid = process.geteuid?.() ?? process.getuid?.();
  if (uid !== undefined && Number(metadata.uid) !== uid) throw new Error(errors.owner);
  const exposed = typeof metadata.mode === 'bigint' ? (metadata.mode & 0o077n) !== 0n : (metadata.mode & 0o077) !== 0;
  if (exposed) throw new Error(errors.mode);
}
