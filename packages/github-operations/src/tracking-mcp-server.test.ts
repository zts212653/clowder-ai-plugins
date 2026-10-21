import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTrackingMcpServer, createRemoteTrackingMcpServer, TRACKING_ACTION_METHODS } from './tracking-mcp-server.js';

test('native MCP exposes the three tracking tools and dispatches directly to package handlers', async () => {
  const calls: unknown[] = [];
  const server = createTrackingMcpServer({
    registerPr: async input => { calls.push(input); return { registered: true }; },
    registerIssue: async input => { calls.push(input); return { registered: true }; },
    unregister: async input => { calls.push(input); return { unregistered: true }; },
  });
  const client = new Client({ name: 'tracking-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), [
      'cat_cafe_register_issue_tracking', 'cat_cafe_register_pr_tracking', 'cat_cafe_unregister_tracking',
    ]);
    assert.ok(tools.every(t => !Object.hasOwn(t.inputSchema.properties ?? {}, 'threadId')));
    const result = await client.callTool({ name: 'cat_cafe_register_pr_tracking',
      arguments: { registrationId: 'registration-1', repoFullName: 'owner/repo', prNumber: 1 } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [{ registrationId: 'registration-1', repoFullName: 'owner/repo', prNumber: 1 }]);
    const missingId = await client.callTool({ name: 'cat_cafe_register_pr_tracking',
      arguments: { repoFullName: 'owner/repo', prNumber: 1 } });
    assert.equal(missingId.isError, true); assert.equal(calls.length, 1);
    const bad = await client.callTool({ name: 'cat_cafe_register_issue_tracking',
      arguments: { repoFullName: 'owner/repo', issueNumber: 0 } });
    assert.equal(bad.isError, true); assert.equal(calls.length, 1);
  } finally { await client.close(); await server.close(); }
});

test('native MCP forwards runtime metadata separately from validated tool arguments', async () => {
  const calls: { method: string; input: unknown; meta: unknown; signal?: AbortSignal }[] = [];
  const server = createRemoteTrackingMcpServer({ invoke: async (method, input, call) => {
    calls.push({ method, input, meta: call._meta, signal: call.signal }); return { registered: true };
  } });
  const client = new Client({ name: 'tracking-native', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const meta = { threadId: 'native-thread', 'x-codex-turn-metadata': { thread_id: 'native-thread', turn_id: 'turn' } };
    const args = { registrationId: 'stable-id', repoFullName: 'owner/repo', issueNumber: 3 };
    const response = await client.callTool({ name: 'cat_cafe_register_issue_tracking', arguments: args, _meta: meta });
    assert.equal(response.isError, undefined);
    assert.equal(calls[0]?.method, TRACKING_ACTION_METHODS.registerIssue);
    assert.deepEqual(calls[0]?.input, args);
    assert.deepEqual(calls[0]?.meta, meta);
    assert.ok(calls[0]?.signal instanceof AbortSignal);
  } finally { await client.close(); await server.close(); }
});

test('remote Community MCP tools carry identity only in runtime metadata and mark route refusal', async () => {
  const calls: any[] = [];
  const server = createRemoteTrackingMcpServer({ invoke: async (method, input, call) => {
    calls.push({ method, input, meta: call._meta }); return { status: 403, body: { error: 'owner mismatch' } };
  } });
  const client = new Client({ name: 'community-native', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  try {
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 11);
    const input = { id: 'issue:org/repo#1', payload: { reason: 'await provider' } }, meta = { threadId: 'real-thread' };
    const result = await client.callTool({ name: 'github_community_await_external', arguments: input, _meta: meta });
    assert.equal(result.isError, true);
    assert.deepEqual(calls, [{ method: 'github.community.await-external', input, meta }]);
    assert.equal(tools.some(t => /http|resolve$/.test(t.name)), false);
  } finally { await client.close(); await server.close(); }
});

test('external review verdict MCP transports business submission separately from native metadata', async () => {
  const calls: any[] = [];
  const server=createRemoteTrackingMcpServer({invoke:async(method,input,call)=>{calls.push({method,input,meta:call._meta});return {data:{lifecycle:'pending_verification'}};}});
  const client=new Client({name:'verdict-native',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
  try {
    const input={repoFullName:'org/repo',prNumber:1,reviewedHeadSha:'a'.repeat(40),verdict:'approved',summary:'Review',delivery:{kind:'delivered',githubUrl:'https://github.com/org/repo/pull/1#pullrequestreview-1'}};
    const result=await client.callTool({name:'github_record_external_review_verdict',arguments:input,_meta:{threadId:'authenticated-transport'}});
    assert.equal(result.isError,undefined);assert.deepEqual(calls,[{method:'github.review.record-verdict',input,meta:{threadId:'authenticated-transport'}}]);
    assert.match(JSON.stringify(result),/pending_verification/);
    const invalid=await client.callTool({name:'github_record_external_review_verdict',arguments:{...input,reviewedHeadSha:'invalid'}});
    assert.equal(invalid.isError,true);assert.equal(calls.length,1);
  } finally {await client.close();await server.close();}
});
