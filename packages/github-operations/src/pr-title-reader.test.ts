import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { GitHubPrTitleReader } from './pr-title-reader.js';

const row = (title = '  Current title  ', number = 12, repository = 'Owner/Repo') => JSON.stringify({ number, title, repository });

test('PR title validates the original full ref and provider subject before caching', async t => {
  let calls = 0, stdout = row();
  const reader = new GitHubPrTitleReader({ token: async () => 'isolated-title-validation',
    execFileAsync: async (_file, args, options) => {
      calls++;
      assert.ok(args.includes('repos/owner/repo/pulls/12'));
      assert.equal(options.timeout, 2_000);
      return { stdout };
    } });
  t.after(() => reader.stop());
  for (const ref of [undefined, '', 'owner/repo#0', 'owner/repo#01', 'owner/repo#-1', 'owner/repo#9007199254740992',
    'bad_/repo#12', '-owner/repo#12', 'owner/..#12', 'owner/repo/more#12', 'https://github.com/owner/repo/pull/12']) {
    assert.equal(await reader.read(ref), null);
  }
  assert.equal(calls, 0);
  for (stdout of [row('T', 11), row('T', 12, 'other/repo'), row('  '), 'null']) {
    assert.equal(await reader.read('OWNER/Repo#12'), null);
  }
  stdout = row();
  assert.equal(await reader.read('OWNER/Repo#12'), 'Current title');
  assert.equal(await reader.read('OWNER/Repo#12'), 'Current title');
  assert.equal(calls, 5, 'invalid/mismatched responses are not cached');
});

test('PR title cache expires at 60 seconds and follows credential changes without sharing across instances', async t => {
  let now = 0, token = 'isolated-title-A', calls = 0;
  const reader = new GitHubPrTitleReader({ token: async () => token, now: () => now,
    execFileAsync: async (_file, _args, opts) => { calls++; return { stdout: row(opts.env?.GITHUB_TOKEN) }; } });
  t.after(() => reader.stop());
  assert.equal(await reader.read('owner/repo#12'), token);
  now = 59_999; assert.equal(await reader.read('owner/repo#12'), token); assert.equal(calls, 1);
  token = 'isolated-title-B'; assert.equal(await reader.read('owner/repo#12'), token); assert.equal(calls, 2);
  token = 'isolated-title-A'; assert.equal(await reader.read('owner/repo#12'), token); assert.equal(calls, 2);
  now = 60_000; await reader.read('owner/repo#12'); assert.equal(calls, 3);
  const other = new GitHubPrTitleReader({ token: async () => token,
    execFileAsync: async () => ({ stdout: row('Other installation') }) });
  t.after(() => other.stop());
  assert.equal(await other.read('owner/repo#12'), 'Other installation');
});

test('PR title cache retains at most 256 successful refs', async t => {
  let calls = 0;
  const reader = new GitHubPrTitleReader({ token: async () => 'isolated-title-bound',
    execFileAsync: async (_file, args) => {
      calls++; const number = Number(args.find(value => /pulls\/[0-9]+$/.test(value))!.split('/').at(-1));
      return { stdout: row(`Title ${number}`, number) };
    } });
  t.after(() => reader.stop());
  for (let i = 1; i <= 257; i++) await reader.read(`owner/repo#${i}`);
  await reader.read('owner/repo#257'); assert.equal(calls, 257);
  await reader.read('owner/repo#1'); assert.equal(calls, 258);
});

test('caller cancellation and stop cancel provider work and never turn aborted replies into cache hits', async t => {
  let calls = 0, entered!: () => void;
  let began = new Promise<void>(resolve => { entered = resolve; });
  const reader = new GitHubPrTitleReader({ token: async () => 'isolated-title-cancel',
    execFileAsync: async (_file, _args, options) => {
      calls++; entered(); await delay(10_000, undefined, { signal: options.signal }); return { stdout: row() };
    } });
  t.after(() => reader.stop());
  const caller = new AbortController();
  const pending = reader.read('owner/repo#12', caller.signal);
  const rejected = assert.rejects(pending, /abort|cancel/i);
  await began; caller.abort(new Error('caller cancelled')); await rejected;
  began = new Promise<void>(resolve => { entered = resolve; });
  const next = reader.read('owner/repo#12'); const stopped = assert.rejects(next, /abort|stopped/i);
  await began; await reader.stop(); await stopped;
  await assert.rejects(reader.read('owner/repo#12'), /stopped/);
  assert.equal(calls, 2);
});

test('the 2-second budget includes an unresolved credential lookup', async t => {
  let calls = 0;
  const reader = new GitHubPrTitleReader({ token: () => new Promise(() => {}),
    execFileAsync: async () => { calls++; return { stdout: row() }; } });
  t.after(() => reader.stop());
  const keepAlive = setTimeout(() => {}, 3_000); t.after(() => clearTimeout(keepAlive));
  const start = Date.now();
  await assert.rejects(reader.read('owner/repo#12'), /timeout|aborted/i);
  assert.ok(Date.now() - start < 2_800); assert.equal(calls, 0);
});

test('an aborted caller cannot use a cached title', async t => {
  const reader = new GitHubPrTitleReader({ token: async () => 'isolated-title-cached', execFileAsync: async () => ({ stdout: row() }) });
  t.after(() => reader.stop());
  await reader.read('owner/repo#12');
  const caller = new AbortController(); caller.abort(new Error('caller cancelled'));
  await assert.rejects(reader.read('owner/repo#12', caller.signal), /cancelled/);
});
