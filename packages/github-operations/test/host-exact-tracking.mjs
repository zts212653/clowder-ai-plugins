// Explicit installed consumer; uses its own portless Redis and never production state.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { installedTrackingHost } from './installed-tracking-host.mjs';
import { artifactImports, seedSettled } from './installed-tracking-history.mjs';

const hostRoot = await realpath(process.env.CLOWDER_1843_HOST_ROOT ?? 'missing-explicit-host-root');
const artifact = await realpath(process.env.CLOWDER_1843_GITHUB_ARTIFACT_ROOT ?? 'missing-explicit-artifact-root');
const host = path => import(pathToFileURL(join(hostRoot, path)).href);
const requireHost = createRequire(join(hostRoot, 'packages/api/package.json'));
const sdk = path => import(pathToFileURL(requireHost.resolve(`@modelcontextprotocol/sdk/${path}`)).href);
const [{ ownedRedisFixture }, { auditRecoveryRedis }, { Client }, { McpServer }, { InMemoryTransport }, manager] = await Promise.all([
  host('packages/api/test/helpers/owned-redis-fixture.js'), host('packages/api/test/helpers/recovery-store-audit.js'),
  sdk('client/index.js'), sdk('server/mcp.js'), sdk('inMemory.js'),
  host('packages/mcp-server/dist/tools/plugin-management-tools.js'),
]);
const requireContract = createRequire(join(artifact, 'node_modules/@clowder-ai/plugin-contract/package.json'));
const Ajv = requireContract('ajv');
const redisFixture = ownedRedisFixture('github-exact-tracking'), load = artifactImports(artifact);

/** The real MCP management handler/SDK transport enters the packed worker.
 * Only inventory/HTTP forwarding is adapted to this isolated installed Host. */
async function mcpConsumer(t, f) {
  const tools = f.manifest.contributions.filter(row => row.type === 'tool' && row.action);
  const validator = new Ajv();
  const handlers = manager.createPluginManagementHandlers({
    async listTools(pluginId) { assert.equal(pluginId, f.manifest.pluginId); return { tools }; },
    async call(pluginId, id, name, args) {
      assert.equal(pluginId, f.manifest.pluginId);
      const declared = tools.find(row => row.id === id && row.name === name);
      assert.ok(declared, 'the installed manifest must declare this exact tool identity');
      assert.equal(validator.validate(declared.inputSchema, args), true, JSON.stringify(validator.errors));
      return f.call(declared.action.method, args);
    },
  });
  const server = new McpServer({ name: 'isolated-installed-manager', version: '1' });
  server.tool('plugin_list_tools', manager.pluginListToolsInputSchema, handlers.listTools);
  server.tool('plugin_call', manager.pluginCallInputSchema, handlers.call);
  const client = new Client({ name: 'exact-query-consumer', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const toolList = await client.callTool({ name: 'plugin_list_tools', arguments: { pluginId: f.manifest.pluginId } });
  const declared = JSON.parse(toolList.content[0].text).tools;
  return async (name, args) => {
    const tool = declared.find(row => row.name === name); assert.ok(tool);
    const result = await client.callTool({ name: 'plugin_call', arguments: { pluginId: f.manifest.pluginId,
      contributionId: tool.id, toolName: tool.name, arguments: args } });
    assert.equal(result.isError ?? false, false, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
}

test('installed MCP exact reads stay constant from 1000 to 10000 unrelated waits and feed the original recovery consumer',
  { timeout: 600_000 }, async t => {
    const f = await installedTrackingHost(t, { hostRoot, artifact, redisFixture });
    await f.runtime.start('instance', f.record);
    await f.call('github.typed-wait.register-pr', { registrationId: 'exact-original-intent', repoFullName: 'owner/repo', prNumber: 1,
      autoRenew: false, when: [{ kind: 'pr_conversation_comment_added', authorLogins: ['contributor'] }] });
    const call = await mcpConsumer(t, f), subjectKey = 'pr:owner/repo#1';
    f.mode.scenario = 'provider-error';
    for (let n = 0; n < 5; n++) { f.mode.now += 60_001; await f.call('github.pr-tracking'); }
    const measure = async () => {
      const audit = await auditRecoveryRedis(f.redis), providerReads = f.providerCalls();
      try {
        const tracking = await call('github_list_tracking', { subjectKey, view: 'recovery' });
        const diagnostics = await call('github_list_tracking', { subjectKey, view: 'diagnostics', registrationId: 'exact-original-intent' });
        const absent = await call('github_list_tracking', { subjectKey: 'pr:absent/repo#999' });
        await audit.flush(); audit.assertIndexed();
        assert.equal(audit.reads.some(row => row.command === 'hscan'), false, 'direct reads must never enumerate the private hash');
        assert.equal(audit.reads.some(row => row.command === 'hgetall' && row.args[0]?.includes('plugin-private-state:')), false);
        assert.equal(f.providerCalls(), providerReads, 'read-only diagnostics must never re-observe GitHub');
        assert.equal(diagnostics.data.diagnostics[0].status, 'registered');
        assert.equal(absent.data.page.returned, 0); assert.equal(absent.data.page.lookup.legacyTaskIdRequired, true);
        assert.equal(tracking.data.page.scanCalls, 0);
        return { tracking, commands: audit.reads.length, hgets: audit.reads.filter(row => row.command === 'hget').length };
      } finally { audit.stop(); }
    };
    await seedSettled(f, load, 'typed', 0, 1000);
    const small = await measure();
    await seedSettled(f, load, 'typed', 1000, 10000);
    const large = await measure();
    assert.equal(large.commands, small.commands); assert.equal(large.hgets, small.hgets);
    const diagnostic = large.tracking.data.recoveryOwners.typed[0];
    assert.equal(large.tracking.data.tracking[0].polling.state, 'paused');
    const before = await f.facade.get(diagnostic.sourceKey), original = before.value.task;
    assert.equal(diagnostic.sourceRevision, before.revision);
    assert.equal(diagnostic.recovery.revision, before.value.recovery.revision);
    assert.deepEqual(small.tracking.data.tracking, large.tracking.data.tracking);
    await call('github_retry_tracking', { taskId: diagnostic.taskId, expectedScope: diagnostic.recovery.scope,
      expectedRecoveryRevision: diagnostic.recovery.revision });
    assert.deepEqual((await f.facade.get(diagnostic.sourceKey)).value.task, original);
    f.mode.scenario = 'event:11'; f.mode.now += 60_001;
    await f.call('github.pr-tracking');
    const delivered = (await f.facade.get(diagnostic.sourceKey)).value.task;
    assert.equal(delivered.automationState.waitOutcome.reason, 'matched');
    assert.equal(delivered.automationState.waitOutcome.generation, original.automationState.await.generation);
    assert.equal(delivered.automationState.waitOutcome.delivery, 'delivered');
    assert.equal(f.sends.filter(row => row.wake?.catId === original.ownerCatId).length, 1);

    const { migratedIssueKey, publishMigratedIssue } = await load('migrated-issue-record.js');
    const legacy = { ...original, id: 'retained-original-legacy', kind: 'issue_tracking', subjectKey: 'issue:owner/repo#9',
      automationState: { issue: { issueState: 'open', lastCommentCursor: 44, lastDeliveredCursor: 44 } } };
    await publishMigratedIssue(f.facade, migratedIssueKey(legacy.id), null,
      { schemaVersion: 1, task: legacy, sourceUpdatedAt: legacy.updatedAt });
    const compatible = await call('github_list_tracking', { subjectKey: legacy.subjectKey, taskId: legacy.id });
    assert.deepEqual(compatible.data.tracking[0], legacy);
    assert.equal(compatible.data.page.scanCalls, 0); assert.equal(compatible.data.page.lookup.coverage, 'task');
    console.log(JSON.stringify({ consumer: 'built MCP SDK + native worker + owned Redis + original retry/delivery',
      small: { unrelated: 1000, commands: small.commands, hgets: small.hgets },
      large: { unrelated: 10000, commands: large.commands, hgets: large.hgets },
      storageScans: 0, providerReadsDuringLookup: 0, recoveredOriginalGeneration: original.automationState.await.generation }));
  });
