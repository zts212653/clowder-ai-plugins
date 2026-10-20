import {
  evaluateConnectorPermission, parseConnectorCommand,
  type ConnectorCommandName, type ConnectorPermissions,
} from './connector-permissions.js';

export interface ConnectorCommandIngress {
  readonly chatId: string;
  readonly providerMessageId: string;
  readonly group: boolean;
  readonly senderId?: string | undefined;
  readonly text: string;
}
export interface ConnectorCommandResult {
  readonly response: string;
  readonly cardActions?: readonly { readonly label: string; readonly value: { readonly cmd: string; readonly args?: string } }[];
  /** Only /ask and /thread bodies may explicitly invoke an agent. */
  readonly forward?: { readonly threadId: string; readonly text: string; readonly catId?: string };
}
export interface ConnectorCommandRoutingPorts {
  getPermissions(): Promise<ConnectorPermissions>;
  execute(command: { readonly name: ConnectorCommandName; readonly args: string }, input: ConnectorCommandIngress): Promise<ConnectorCommandResult>;
  reply(chatId: string, text: string, result: ConnectorCommandResult | undefined, input: ConnectorCommandIngress): Promise<void>;
  /** Records the exchange on the source's system thread without external-origin wake. */
  audit(input: ConnectorCommandIngress, response: string): Promise<void>;
  forward(input: ConnectorCommandIngress, body: NonNullable<ConnectorCommandResult['forward']>): Promise<void>;
  /** Release provider tasks after non-forwarded commands/denials, never before an agent reply. */
  settle(input: ConnectorCommandIngress): Promise<void>;
}

/** Shared pre-ingress fence. The caller may send ordinary ingress ONLY on 'message'. */
export async function routeConnectorCommand(input: ConnectorCommandIngress, ports: ConnectorCommandRoutingPorts): Promise<'blocked' | 'command' | 'message'> {
  if (typeof input.group !== 'boolean' || typeof input.text !== 'string' || typeof input.chatId !== 'string' || !input.chatId.trim()) {
    throw new TypeError('connector command requires explicit provider conversation facts');
  }
  const decision = evaluateConnectorPermission(await ports.getPermissions(), input);
  if (decision !== 'allowed') {
    await ports.reply(input.chatId, decision === 'group_not_allowed'
      ? '🔒 此群未在白名单中，请联系管理员。' : '🔒 命令仅管理员可用。', undefined, input);
    await ports.settle(input);
    return 'blocked';
  }
  const command = parseConnectorCommand(input.text);
  if (command === null) return 'message';
  const result = await ports.execute(command, input);
  if (typeof result.response !== 'string' || !result.response) throw new TypeError('command requires a provider response');
  if (result.forward !== undefined && command.name !== 'ask' && command.name !== 'thread') {
    throw new TypeError('only ask/thread may forward an explicit body');
  }
  // A success response describes accepted forwarding, not a plan. Host may
  // reject the body after persistence/queue admission; never acknowledge or
  // audit it as sent before its send promise confirms acceptance.
  if (result.forward !== undefined) await ports.forward(input, result.forward);
  await ports.reply(input.chatId, result.response, result, input);
  await ports.audit(input, result.response);
  if (result.forward === undefined) await ports.settle(input);
  return 'command';
}

/** Per-runtime bounded replay fence, preserving the old Host router's lifetime.
 * This is not a durable workflow or a claim of deduplication across restart. */
export function createConnectorCommandRouter(ports: ConnectorCommandRoutingPorts, maximum = 10_000) {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new TypeError('invalid replay fence bound');
  const seen = new Map<string, symbol>();
  return async (input: ConnectorCommandIngress, deliverMessage?: () => Promise<void>): Promise<'blocked' | 'command' | 'message' | 'duplicate'> => {
    if (typeof input.providerMessageId !== 'string' || !input.providerMessageId.trim()) throw new TypeError('missing provider event identity');
    const key = JSON.stringify([input.chatId, input.providerMessageId]);
    if (seen.has(key)) return 'duplicate';
    // A missing/invalid migrated policy has no ingress effect. Do not consume
    // the event before an owner can repair it, but recheck after this await so
    // two simultaneous preflights still admit just one mutation.
    const permissions = await ports.getPermissions();
    if (seen.has(key)) return 'duplicate';
    const ordinary = evaluateConnectorPermission(permissions, input) === 'allowed' && parseConnectorCommand(input.text) === null;
    if (seen.size >= maximum) seen.delete(seen.keys().next().value!);
    const claim = Symbol();
    seen.set(key, claim); // Claim before the first side-effecting await.
    try {
      const outcome = await routeConnectorCommand(input, { ...ports, getPermissions: async () => permissions });
      if (outcome === 'message') await deliverMessage?.();
      return outcome;
    } catch (error) {
      // Ordinary ingress retains its original Host idempotency key and media
      // locator ownership. A transport failure must remain retryable; command
      // mutations/denials may already have provider effects and remain fenced.
      if (ordinary && seen.get(key) === claim) seen.delete(key);
      throw error;
    }
  };
}

/** Permission mutation is plugin business. Host supplies only scoped durable storage. */
export async function executeConnectorPermissionCommand(
  command: { readonly name: 'allow-group' | 'deny-group'; readonly args: string },
  input: { readonly chatId: string; readonly senderId?: string | undefined },
  policy: ConnectorPermissions,
  store: { allowGroup(id: string): Promise<{ readonly allowedGroups: readonly unknown[] }>; denyGroup(id: string): Promise<boolean> },
): Promise<ConnectorCommandResult> {
  if (input.senderId === undefined || !policy.adminOpenIds.includes(input.senderId)) return { response: '🔒 此命令仅管理员可用。' };
  const target = command.args.trim() || input.chatId;
  if (command.name === 'allow-group') {
    const result = await store.allowGroup(target);
    return { response: `✅ 群 ${target.slice(-8)} 已加入白名单（共 ${result.allowedGroups.length} 个群）` };
  }
  const removed = await store.denyGroup(target);
  return { response: removed ? `🚫 群 ${target.slice(-8)} 已从白名单移除` : `⚠️ 群 ${target.slice(-8)} 不在白名单中` };
}
