import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

import { GITHUB_SCHEDULES } from './schedules.js';

test('schedule carrier deadlines leave settlement room around bounded PR/Issue polling', () => {
  assert.deepEqual(GITHUB_SCHEDULES, [
    { id: 'pr-tracking', everyMs: 60_000, timeoutMs: 90_000 },
    { id: 'repo-scan', everyMs: 300_000, timeoutMs: 90_000 },
    { id: 'issue-tracking', everyMs: 60_000, timeoutMs: 90_000 },
    { id: 'repo-comment-poll', everyMs: 60_000, timeoutMs: 120_000 },
    { id: 'community-reconciler', everyMs: 600_000, timeoutMs: 120_000 },
  ]);
});

test('manifest schedule contributions match package-owned inventory exactly', async () => {
  const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as {
    contributions: Array<{ type: string; id: string; schedule?: { everyMs?: number }; policy?: { timeoutMs?: number } }>;
  };
  const schedules = manifest.contributions
    .filter(item => item.type === 'schedule')
    .map(item => ({ id: item.id, everyMs: item.schedule?.everyMs, timeoutMs: item.policy?.timeoutMs }));
  assert.deepEqual(schedules, [...GITHUB_SCHEDULES]);
});

test('runtime source contains no ambient token, env, or persistence fallback', async () => {
  const source = await readFile(new URL('./schedules.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /process\.env|readFile|writeFile|Redis|GITHUB_TOKEN|GITHUB_MCP_PAT/);
});

test('native tracking MCP and skill use the same installed entrypoint and direct tool names', async () => {
  const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));
  const skill = manifest.contributions.find((item: { type: string }) => item.type === 'skill');
  assert.equal(skill.path, 'skills/github-operations');
  const content = await readFile(new URL(`../${skill.path}/SKILL.md`, import.meta.url), 'utf8');
  assert.match(content, /cat_cafe_register_pr_tracking/);
  assert.match(content, /cat_cafe_register_issue_tracking/);
  assert.match(content, /cat_cafe_unregister_tracking/);
  assert.doesNotMatch(content, /plugin_call/);
  assert.deepEqual(manifest.contributions.filter((item: { type: string }) => item.type === 'mcp'),
    [{ type: 'mcp', id: 'github-tracking', runtime: { transport: 'stdio', entrypoint: 'dist/mcp-entrypoint.js' },
      sharedFactory: { module: 'dist/tracking-mcp-server.js', export: 'createRemoteTrackingMcpServer' } }]);
  assert.equal(manifest.runtime.transport, 'builtin');
});
