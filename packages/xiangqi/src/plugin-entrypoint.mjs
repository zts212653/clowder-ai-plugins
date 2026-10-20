import { fork } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChildRpc } from './child-rpc.mjs';
import { ownerLaunchPage } from './owner-launch-page.mjs';

function fields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key)))
    throw new Error('请求包含不支持的字段');
  return input;
}
async function requireCaller(context) {
  if (!context || typeof context.assertCurrent !== 'function' ||
    !['userId', 'threadId', 'catId', 'invocationId'].every(key => typeof context[key] === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(context[key])))
    throw new Error('需要宿主认证的当前猫调用');
  await context.assertCurrent();
  return { userId: context.userId, threadId: context.threadId, catId: context.catId };
}

export async function startPlayableXiangqi(host) {
  let stopped = false;
  const active = () => { if (stopped) throw new Error('象棋插件已停止'); };
  const roster = async binding => {
    active();
    const thread = await host.threads.get(binding.threadId);
    const cats = await host.threads.getCats(binding.threadId);
    const cat = [...cats.participants, ...cats.routableNow].find(value => value.catId === binding.catId);
    if (!thread || !cat) throw new Error('原对话或棋搭子当前不可用');
    active();
    return cat;
  };
  const child = fork(fileURLToPath(new URL('./game-child.mjs', import.meta.url)), [], {
    env: Object.fromEntries(['PATH', 'TMPDIR', 'TEMP', 'SystemRoot'].filter(key => process.env[key]).map(key => [key, process.env[key]])),
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [],
  });
  // The child never receives Host callback credentials or ambient home/account paths.
  child.stderr.on('data', () => {});
  const rpc = createChildRpc(child, async (method, input) => {
    active();
    if (method !== 'notify') throw new Error('未声明的宿主操作');
    const { binding, event } = input;
    await roster(binding);
    const text = `棋局 ${binding.gameId}：人类已确认落子，当前版本 ${event.stateRevision}。请调用 xiangqi_read_game 读取该版本的局面和候选，亲自选择后用 xiangqi_play_move 提交。不要替人落子或自动代选；若版本变化，重新读取。`;
    const result = await host.messaging.send({
      threadId: binding.threadId, identity: 'xiangqi', wake: { catId: binding.catId },
      idempotencyKey: `xiangqi:${binding.gameId}:${event.actionId}`,
      payload: {
        provenance: { origin: { kind: 'plugin', instanceId: host.pluginInstanceId }, epistemicStatus: 'observation' },
        elements: [{ elementId: 'move', kind: 'text', payload: { text } }],
      },
    });
    active();
    return { actionId: event.actionId, operationDigest: event.operationDigest, receiptId: result.messageId };
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.once('exit', () => { stopped = true; rpc.close(); });
  try { await rpc.call('initialize', { dataRoot: join(host.dataPath, 'games') }); }
  catch (error) { child.kill(); rpc.close(); throw error; }

  const guarded = async (input, context, allowed) => {
    active(); fields(input, allowed);
    const caller = await requireCaller(context);
    const binding = await rpc.call('binding', input.gameId);
    if (binding.revoked || ['userId', 'threadId', 'catId'].some(key => binding[key] !== caller[key]))
      throw new Error('当前猫或对话与这盘棋不匹配');
    await roster(binding);
    await context.assertCurrent();
    return binding;
  };
  return {
    actions: {
      async 'xiangqi.open'(input, context) {
        active(); fields(input, ['gameId']);
        const caller = await requireCaller(context);
        // Typed wait metadata is optional on ordinary native invocations. The
        // authenticated origin and its public message facts establish consent.
        const sourceId = context.originTriggerMessageId ?? context.source?.sourceMessageId;
        if (context.ownerAuthProvenance !== 'strict' || (context.source && context.source.kind !== 'primary') ||
          typeof sourceId !== 'string' || !sourceId || sourceId.length > 500)
          throw new Error('请由人类在当前对话请求打开棋盘');
        const source = await host.messaging.get(sourceId);
        if (!source || source.catId !== null || source.source || source.userId !== caller.userId || source.threadId !== caller.threadId)
          throw new Error('打开棋盘需要当前对话的人类授权来源');
        const cat = await roster(caller);
        await context.assertCurrent();
        const { url: _privateLaunch, ...result } = await rpc.call('open', { ...caller, ...input, humanName: '你', companionName: cat.displayName });
        await context.assertCurrent();
        return { ...result, launchPath: `/api/plugins/dev.clowder.xiangqi/board/${result.gameId}` };
      },
      async 'xiangqi.launch'(input, native, owner) {
        active();
        if (native !== undefined || owner?.kind !== 'owner-http-request' || owner.operation !== 'read' ||
          typeof owner.assertCurrent !== 'function' || !owner.pluginInstanceId ||
          owner.pluginInstanceId !== host.pluginInstanceId)
          throw new Error('打开棋盘需要宿主浏览器的已认证用户会话');
        owner.signal.throwIfAborted();
        await owner.assertCurrent();
        const request = fields(input, ['request']).request;
        const match = /^board\/(game_[a-f0-9]{32})$/.exec(request?.path ?? '');
        if (request?.method !== 'GET' || !match || request.principal?.id !== owner.userId ||
          (owner.requestIdentity && (owner.requestIdentity.path !== request.path || owner.requestIdentity.method !== 'GET')))
          throw new Error('棋盘入口请求无效');
        const binding = await rpc.call('binding', match[1]);
        if (binding.revoked || binding.userId !== owner.userId) throw new Error('棋盘不属于当前用户或已停用');
        await roster(binding);
        await owner.assertCurrent();
        const opened = await rpc.call('open', { ...binding, browserLaunch: true });
        await owner.assertCurrent();
        owner.signal.throwIfAborted();
        return ownerLaunchPage(opened.url);
      },
      async 'xiangqi.read'(input, context) {
        await guarded(input, context, ['gameId', 'revision', 'timeMs', 'maxDepth']);
        if (!Number.isSafeInteger(input.revision) || input.revision < 0 ||
          (input.timeMs !== undefined && (!Number.isInteger(input.timeMs) || input.timeMs < 1 || input.timeMs > 10_000)) ||
          (input.maxDepth !== undefined && (!Number.isInteger(input.maxDepth) || input.maxDepth < 1 || input.maxDepth > 7)))
          throw new Error('无效版本或搜索预算');
        const result = await rpc.call('candidates', input);
        await context.assertCurrent();
        return result;
      },
      async 'xiangqi.play'(input, context) {
        await guarded(input, context, ['gameId', 'revision', 'move']);
        if (!Number.isSafeInteger(input.revision) || input.revision < 0 || typeof input.move !== 'string' || !/^[a-i][0-9][a-i][0-9]$/.test(input.move))
          throw new Error('无效版本或棋步');
        const result = await rpc.call('play', input);
        await context.assertCurrent();
        return result;
      },
    },
    async stop({ reason = 'disabled' } = {}) {
      if (stopped) return;
      // Revoke board sessions and pending work on explicit disable/uninstall; an
      // unexpected process death is recovered from the same retained journal.
      await rpc.call('stop', { revoke: !/shutdown|restart/i.test(reason) }).catch(() => {});
      stopped = true;
      rpc.close();
      child.disconnect();
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exited;
      clearTimeout(timer);
    },
  };
}

export default Object.freeze({
  create(manifest) {
    if (manifest?.pluginId !== 'dev.clowder.xiangqi') throw new Error('错误的象棋插件声明');
    return { start: startPlayableXiangqi };
  },
});
