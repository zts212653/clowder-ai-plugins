import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';
import { validateManifest } from '../packages/plugin-contract/src/validation/manifest.ts';
import { createDingTalkPluginModule } from '../packages/connector-dingtalk/src/plugin-entrypoint.ts';
import { createFeishuPluginModule } from '../packages/connector-feishu/src/plugin-entrypoint.ts';
import { createWeComBotPluginModule } from '../packages/connector-wecom-bot/src/plugin-entrypoint.ts';

for (const [name, label, create] of [
  ['dingtalk', '钉钉', createDingTalkPluginModule],
  ['feishu', '飞书', createFeishuPluginModule],
  ['wecom-bot', '企业微信', createWeComBotPluginModule],
]) {
  test(`${name}: one original declaration is consumed directly by the current SDK`, async () => {
    const root = new URL(`../packages/connector-${name}/`, import.meta.url);
    const manifest = parse(await readFile(new URL('plugin.yaml', root), 'utf8'));
    const before = structuredClone(manifest);
    assert.deepEqual(manifest.permissions, { label });
    assert.equal(validateManifest(manifest).valid, true);
    assert.equal(typeof create().create(manifest).start, 'function');
    assert.deepEqual(manifest, before, 'Host declaration cannot be mutated by runtime projection');
    if (name === 'feishu') {
      assert.deepEqual(manifest.steps.filter(step => step.mode).map(step => step.mode), ['webhook', 'websocket']);
      assert.equal(manifest.steps[2].text, '在「事件订阅」中配置请求地址并获取 Verification Token');
    }
  });
  test(`${name}: the current validator rejects unknown execution fields or malformed original declarations`, async () => {
    const manifest = parse(await readFile(new URL(`../packages/connector-${name}/plugin.yaml`, import.meta.url), 'utf8'));
    for (const change of [
      { permissions: { label, grant: 'task.write' } },
      { permissions: { label: 1 } },
      { permissions: null },
      { steps: [{ text: 'Step', mode: 1 }] },
      { steps: [{ text: 'Step', mode: 'webhook', authority: 'forged' }] },
      { executionAuthority: 'forged' },
    ]) assert.throws(() => create().create({ ...manifest, ...change }));
  });
}

// Original HubConnectorConfigTab rendered guideSteps after mode filtering and
// omitted its final YAML instruction; the new generic plugin renderer shows all.
const guides = {
  dingtalk: [
    { text: '在钉钉开放平台创建企业内部应用，获取 App Key 和 App Secret' },
    { text: '在「机器人与消息推送」中开启机器人能力' },
  ],
  feishu: [
    { text: '在飞书开放平台创建企业自建应用，获取 App ID 和 App Secret' },
    { text: '选择连接模式：Webhook（需公网 URL）或 WebSocket（无需公网，推荐内网环境）' },
    { text: '在「事件订阅」中配置请求地址并获取 Verification Token', mode: 'webhook' },
    { text: '在「事件订阅」中选择「使用长连接接收事件」，无需 Verification Token', mode: 'websocket' },
  ],
  telegram: [
    { text: '在 Telegram 中找到 @BotFather，发送 /newbot 创建机器人' },
    { text: '复制生成的 Bot Token' },
  ],
  'wecom-agent': [
    { text: '点击上方链接登录企微管理后台 → 创建自建应用，获取 AgentId 和 Secret' },
    { text: '在「API 接收消息」中设置回调 URL、Token 和 EncodingAESKey' },
    { text: '回调 URL 需通过公网访问（可使用 Cloudflare Tunnel）' },
  ],
  'wecom-bot': [
    { text: '点击上方链接直接进入创建页 → 选「API 模式」→ 连接方式选「使用长连接」' },
    { text: '填写名称和可见范围，保存后获取 Bot ID 和 Secret' },
  ],
  weixin: [
    { text: '点击「生成二维码」按钮' },
    { text: '使用微信扫描二维码并确认授权' },
  ],
  xiaoyi: [
    { text: '在小艺开放平台创建 OpenClaw 模式智能体，获取 AK/SK 和 Agent ID' },
    // Saving now reloads configuration according to enabled intent.
    { text: '填写以下配置并保存，启用后通过 WebSocket 连接华为 HAG' },
  ],
};
for (const [name, expected] of Object.entries(guides)) {
  test(`${name}: declaration contains only the original visible setup guide`, async () => {
    const manifest = parse(await readFile(new URL(`../packages/connector-${name}/plugin.yaml`, import.meta.url), 'utf8'));
    assert.deepEqual(manifest.steps, expected);
    assert.equal(manifest.steps.some(step => step.text.includes('重启')), false);
  });
}

for (const name of ['dingtalk','feishu','telegram','wecom-agent','wecom-bot','weixin','xiaoyi']) {
  test(`${name}: current module uses ordinary threads, a single delivery and explicit resource refresh`, async () => {
    const root = new URL(`../packages/connector-${name}/`, import.meta.url);
    const entry = await import(new URL('src/plugin-entrypoint.ts', root));
    const factory = Object.entries(entry).find(([key,value])=>/^create.*PluginModule$/.test(key)&&typeof value==='function')[1];
    const storage=new Map(),threads=new Map(),tokens=[],replies=[];let inbound,starts=0,stops=0,downloads=0,secret='first';
    const runtimeFactory=options=>{
      inbound=options.host.deliver;tokens.push(options.config);
      return {outbound:{sendReply:async(...args)=>replies.push(args),sendFormattedReply:async(...args)=>replies.push(args),sendRichMessage:async(...args)=>replies.push(args),sendMedia:async()=>{},
        sendPlaceholder:async()=> 'placeholder',editMessage:async()=>true,deleteMessage:async()=>{},onDeliveryBatchDone:async()=>{},
        downloadInboundMedia:async()=>{downloads++;return Buffer.from('private bytes');},downloadMedia:async()=>{downloads++;return Buffer.from('private bytes');}},
        start:async()=>{starts++;},stop:async()=>{stops++;},isConnected:()=>true,isPolling:()=>true,getConnectionState:()=> 'connected'};
    };
    const host={pluginInstanceId:'isolated-'+name,dataPath:'/isolated/'+name,
      config:{get:async key=>key==='connectionMode'?'websocket':key==='voiceItemMode'?'minimal':key==='enableUnsafeVoiceModes'||key==='captureInboundVoiceMedia'?false:key==='groupBotMentionsJson'?undefined:'value'},
      secrets:{get:async()=>secret},storage:{get:async key=>storage.get(key),list:async()=>Object.fromEntries(storage),
        set:async(key,value)=>{const revision=(storage.get(key)?.revision??0)+1;storage.set(key,{revision,value});return{revision};},
        compareAndSet:async(key,expected,value)=>{if((storage.get(key)?.revision??null)!==expected)return{applied:false};const revision=(expected??0)+1;storage.set(key,{revision,value});return{applied:true,revision};},delete:async key=>({deleted:storage.delete(key)})},
      threads:{get:async id=>threads.get(id)??null,create:async input=>{const row={id:'thread-'+(threads.size+1),title:input.title,deepLinkUrl:'https://local/thread',createdAt:1,lastActiveAt:1,preferredCats:[],featureRefs:[]};threads.set(row.id,row);return row;},list:async()=>[...threads.values()],readMessages:async()=>[],getCats:async()=>({participants:[],routableNow:[],routableNotJoined:[],notRoutable:[]}),update:async()=>{throw Error('unused');},addParticipants:async()=>{throw Error('unused');}},
      messaging:{send:async input=>({messageId:'inbound',threadId:input.threadId}),subscribe:async()=>{},unsubscribe:async()=>{}},tasks:{},streams:{read:async function*(){yield new Uint8Array([1]);}},log(){}};
    const manifest=parse(await readFile(new URL('plugin.yaml',root),'utf8'));
    const before=structuredClone(manifest),active=await factory(runtimeFactory).create(manifest).start(host);
    try {
      assert.deepEqual(manifest,before);assert.equal(starts,1);assert.equal(active.actions['host.messaging.lifecycle'],undefined);
      assert.equal(active.actions[`${name}.media-source.read`],undefined);assert.equal(active.actions[`${name}.media-source.settle`],undefined);
      await inbound({externalConversationId:'chat',externalSenderId:'sender',providerMessageId:'first',providerConversationId:'chat',text:'hello',chatType:'p2p',conversation:{type:'direct'},sender:{id:'sender'}});
      assert.equal(threads.size,1);assert.equal(storage.has('connector.permissions.v1'),false);
      const receipt=await active.actions[`${name}.outbound`]({kind:'message',deliveryId:'delivery',threadId:'thread-1',presentation:{actor:{displayName:'Cat',emoji:'🐱'},thread:{shortId:'thread-1'}},envelope:{messageId:'cat-message',revision:1,threadId:'thread-1',actor:{kind:'cat',id:'cat'},audience:{kind:'public'},occurredAt:'2026-10-18T00:00:00.000Z',payload:{provenance:{origin:{kind:'host'},epistemicStatus:'observation'},elements:[{elementId:'text',kind:'text',payload:{text:'reply'}}]}}});
      assert.deepEqual(receipt,{deliveryId:'delivery'});assert.equal(replies.length,1);
      secret='second';await active.configRefresh();assert.equal(starts,2);assert.equal(stops,1);assert.notDeepEqual(tokens[0],tokens[1]);
    }finally{await active.stop({reason:'test'});}
    assert.equal(stops,2);
  });
}
