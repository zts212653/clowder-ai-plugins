import { randomUUID } from 'node:crypto';
import { NativeRequestError } from './native-stdio.mjs';

const UPSTREAM = 'ed976d78c1e1cc2a49ad17d1e2c0da023bbb5c8e';
const CAPABILITIES = ['stdio-v1', 'text-protocol-subset', 'account-login-v1', 'durable-text-send-v1', 'durable-text-sync-v1', 'current-directory-v1', 'explicit-session-resume-v1'];
const bool = value => typeof value === 'boolean';
const uint = (min = 0, max = Number.MAX_SAFE_INTEGER) => value => Number.isSafeInteger(value) && value >= min && value <= max;
const text = (max, empty = false) => value => typeof value === 'string' && (empty || value.length > 0) && value.isWellFormed() && !value.includes('\0') && Buffer.byteLength(value) <= max;
const coordinate = value => text(256)(value) && !/[\s\u0000-\u001f\u007f]/u.test(value);
const key = value => text(128)(value) && /^[A-Za-z0-9_.:-]+$/.test(value);
const cursor = value => typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
const serverId = value => cursor(value) && value !== '0';
const nullable = check => value => value === null || check(value);
const oneOf = values => value => values.includes(value);
const list = (check, max) => value => Array.isArray(value) && value.length <= max && value.every(check);
const record = fields => value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === Object.keys(fields).length && Object.entries(fields).every(([name, check]) => Object.hasOwn(value, name) && check(value[name]));
const leaseShape = record({ accountGeneration: uint(1), conversationGeneration: uint(1), destination: coordinate });
const receiptShape = record({ id: key, destination: coordinate, accountGeneration: uint(1), conversationGeneration: uint(1),
  state: oneOf(['queued', 'submitting', 'accepted', 'failed', 'needs_review', 'cancelled']), createdAt: uint(1, 0xffffffff), clientMessageId: uint(1, 0xffffffff), serverId: nullable(serverId) });
const egressShape = record({ host: coordinate, port: uint(1, 65535), resolvedIps: list(text(64), 64), longConnections: uint(), longBytesWritten: uint(), longBytesRead: uint(),
  shortRequests: uint(), shortBodyBytesPrepared: uint(), shortResponseBodyBytesRead: uint(), systemFakeIpObserved: bool, verifiedPinVersions: list(uint(1, 0xffffffff), 64), verifiedRegions: list(uint(0, 0xffffffff), 64) });
const accountShape = record({ serverId: coordinate, accountGeneration: uint(), accountIdentity: nullable(coordinate), credentialsAvailable: bool,
  authenticated: bool, connection: oneOf(['online', 'stored', 'offline', 'closed']), egress: list(egressShape, 64) });
const loginRecord = record({ id: key, generation: uint(1), accountGeneration: uint(), phase: oneOf(['starting', 'pending', 'scanned', 'completing', 'succeeded', 'cancelled', 'interrupted', 'failed', 'expired', 'rejected', 'lan_required']),
  accountIdentity: nullable(coordinate), startedAtMs: uint(1), updatedAtMs: uint(1), authenticationMayHaveOccurred: bool });
const png = value => {
  if (typeof value !== 'string' || value.length > 699052) return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length <= 512 * 1024 && bytes.toString('base64') === value && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
};
const loginShape = record({ operation: loginRecord, qr: nullable(record({ pngBase64: png, expiresAt: uint(1, 0xffffffff) })) });
const resumeShape = record({ id: key, sourceGeneration: uint(1), accountGeneration: uint(1), accountIdentity: coordinate, phase: oneOf(['authenticating', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  authenticationMayHaveOccurred: bool, startedAtMs: uint(1), updatedAtMs: uint(1) });
const directoryShape = record({ operationId: key, accountGeneration: uint(1), accountIdentity: coordinate, phase: oneOf(['catalog', 'groups', 'verifying', 'ready', 'failed', 'interrupted']),
  catalogComplete: bool, verifiedCount: uint(0, 10000), unverifiedCount: uint(), groupDiscoveryIncomplete: bool, snapshotAvailable: bool, observedAt: nullable(uint(1)), retryAfterMs: uint() });
const targetShape = record({ id: coordinate, kind: oneOf(['direct', 'group']), displayName: text(512), nickname: nullable(text(512)), remark: nullable(text(512)), alias: nullable(text(512)) });
const eventShape = record({ cursor: serverId, messageId: coordinate, threadId: coordinate, createdAt: uint(0, 0xffffffff) });
const messageShape = record({ id: coordinate, accountGeneration: uint(1), accountIdentity: coordinate, threadId: coordinate, senderId: nullable(coordinate),
  direction: oneOf(['incoming', 'outgoing']), serverId: nullable(serverId), messageType: value => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647,
  body: nullable(text(65536, true)), createdAt: uint(0, 0xffffffff) });
const sameLease = (a, b) => a.accountGeneration === b.accountGeneration && a.conversationGeneration === b.conversationGeneration && a.destination === b.destination;

/** This adapter sees only closed public projections. Raw native objects,
 * credentials, transport diagnostics and protocol snapshots never leave it. */
export class NativeLinkClient {
  constructor({ transport, pid, version }) {
    if (!transport || !uint(1)(pid) || !text(64)(version)) throw new NativeRequestError('invalid_request');
    Object.assign(this, { transport, pid, version }); this.instanceId = randomUUID(); this.ready = false;
  }
  invalid(mayHaveCommitted = false) { this.ready = false; this.transport.close(); throw new NativeRequestError('invalid_response', mayHaveCommitted); }
  async request(method, params, check) {
    const value = await this.transport.request(method, params);
    if (!check(value)) this.invalid(true);
    return structuredClone(value);
  }
  async handshake() {
    const hello = await this.request('hello', {}, record({ product: value => value === 'clowder-wechat-link', version: value => value === this.version,
      pid: value => value === this.pid, protocolVersion: value => value === 1, upstreamCommit: value => value === UPSTREAM,
      capabilities: value => list(oneOf(CAPABILITIES), CAPABILITIES.length)(value) && new Set(value).size === CAPABILITIES.length,
      nativeApiAvailable: value => value === true, accountServiceReady: bool }));
    await this.status(); this.ready = true; return hello;
  }
  async status() {
    const account = await this.request('status', {}, accountShape);
    if (account.authenticated !== (account.connection === 'online') || account.authenticated && (!account.credentialsAvailable || !account.accountIdentity || account.accountGeneration < 1) ||
        account.credentialsAvailable !== (account.accountIdentity !== null) || this.storeId && this.storeId !== account.serverId) this.invalid();
    this.storeId = account.serverId; this.account = account; return account;
  }
  async identity(accountId) {
    this.accountId(accountId); const account = await this.status();
    return { accountId, serverId: this.instanceId, nativeStoreId: this.storeId, accountGeneration: account.accountGeneration,
      accountIdentity: account.accountIdentity, credentialsAvailable: account.credentialsAvailable, connected: account.authenticated && account.connection === 'online' };
  }
  accountId(value) { if (value !== 'clowder') throw new NativeRequestError('invalid_request'); }
  admitted(run, { current = true } = {}) {
    this.accountId(run.accountId);
    if (!this.ready || !key(run.id) || !coordinate(run.accountIdentity) || !coordinate(run.conversationId) || !leaseShape(run.nativeLease) ||
        run.nativeLease.destination !== run.conversationId || run.nativeStoreId !== this.storeId ||
        this.account?.accountIdentity !== run.accountIdentity || current && (run.serverId !== this.instanceId || !this.account.authenticated || run.nativeLease.accountGeneration !== this.account.accountGeneration))
      throw new NativeRequestError('permission_denied');
  }
  async prepare(run) { await this.status(); this.admitted(run); }
  async authorize(accountId, identity, destination, expiresAt = null) {
    this.accountId(accountId);
    if (!this.ready || identity.serverId !== this.instanceId || identity.nativeStoreId !== this.storeId || !identity.connected || !coordinate(destination) || identity.accountIdentity !== this.account?.accountIdentity ||
        !uint(1)(identity.accountGeneration) || expiresAt !== null && !uint(1)(expiresAt)) throw new NativeRequestError('permission_denied');
    const value = await this.request('conversation.authorize', { accountGeneration: identity.accountGeneration, accountIdentity: identity.accountIdentity, destination, expiresAtMs: expiresAt }, leaseShape);
    if (value.accountGeneration !== identity.accountGeneration || value.destination !== destination) this.invalid(true);
    return value;
  }
  async pause(accountGeneration, destination = null) {
    if (!uint()(accountGeneration) || destination !== null && !coordinate(destination)) throw new NativeRequestError('invalid_request');
    return this.request('conversation.pause', { accountGeneration, destination }, record({ paused: value => value === true }));
  }
  normalize(run, receipt) {
    if (!receiptShape(receipt) || receipt.id !== run.id || !sameLease(receipt, run.nativeLease) || (receipt.state === 'accepted') !== (receipt.serverId !== null)) this.invalid(true);
    return { sendId: receipt.id, state: receipt.state, serverId: receipt.serverId };
  }
  async submit(run) {
    this.admitted(run);
    if (!text(65536)(run.text) || !run.text.trim()) throw new NativeRequestError('invalid_request');
    // request writes before its first await. The service orders this physical
    // handoff against its durable stop; never look up a newer lease here.
    return this.normalize(run, await this.request('text.send', { operationId: run.id, lease: run.nativeLease, text: run.text }, receiptShape));
  }
  async inspect(run) {
    this.admitted(run, { current: false });
    return this.normalize(run, await this.request('send.receipt', { operationId: run.id }, receiptShape));
  }
  async cancel(run) {
    this.admitted(run, { current: false });
    return this.normalize(run, await this.request('send.cancel', { operationId: run.id }, receiptShape));
  }
  async startLogin(operationId) { return this.loginRequest('login.start', operationId); }
  async pollLogin(operationId) { return this.loginRequest('login.poll', operationId); }
  async loginOperation(operationId) { return this.loginRequest('login.operation', operationId); }
  async cancelLogin(operationId) { return this.loginRequest('login.cancel', operationId); }
  async loginRequest(method, operationId) {
    if (!this.ready || !key(operationId)) throw new NativeRequestError('invalid_request');
    const value = await this.request(method, { operationId }, loginShape);
    if (value.operation.id !== operationId || value.operation.updatedAtMs < value.operation.startedAtMs ||
        (value.operation.phase === 'succeeded') !== (value.operation.accountIdentity !== null) || value.qr && !['pending', 'scanned'].includes(value.operation.phase)) this.invalid(true);
    return value;
  }
  async resume(operationId, identity) {
    if (!this.ready || !key(operationId) || !uint(1)(identity.accountGeneration) || !coordinate(identity.accountIdentity)) throw new NativeRequestError('invalid_request');
    return this.resumeRequest('session.resume', { operationId, accountGeneration: identity.accountGeneration, accountIdentity: identity.accountIdentity });
  }
  async resumeOperation(operationId) { return this.resumeRequest('session.operation', { operationId }); }
  async cancelResume(operationId) { return this.resumeRequest('session.cancel', { operationId }); }
  async resumeRequest(method, params) {
    if (!this.ready || !key(params.operationId)) throw new NativeRequestError('invalid_request');
    const value = await this.request(method, params, resumeShape);
    if (value.id !== params.operationId || value.accountGeneration !== value.sourceGeneration + 1 || value.updatedAtMs < value.startedAtMs || !value.authenticationMayHaveOccurred ||
        params.accountGeneration && (value.sourceGeneration !== params.accountGeneration || value.accountIdentity !== params.accountIdentity)) this.invalid(true);
    return value;
  }
  async disconnect(accountId) {
    this.accountId(accountId);
    const value = await this.request('account.disconnect', {}, record({ serverId: value => value === this.storeId, accountGeneration: uint(), accountIdentity: value => value === null, credentialsAvailable: value => value === false,
      authenticated: value => value === false, connection: value => value === 'offline' }));
    this.account = { ...value, egress: [] }; return value;
  }
  async directoryStart(operationId, identity) { return this.directoryRequest('directory.start', { operationId, accountGeneration: identity.accountGeneration, accountIdentity: identity.accountIdentity }); }
  async directoryAdvance(operationId) { return this.directoryRequest('directory.advance', { operationId }); }
  async directoryOperation(operationId) { return this.directoryRequest('directory.operation', { operationId }); }
  async directoryRequest(method, params) {
    if (!this.ready || !key(params.operationId)) throw new NativeRequestError('invalid_request');
    const value = await this.request(method, params, directoryShape);
    if (value.operationId !== params.operationId || params.accountGeneration && (value.accountGeneration !== params.accountGeneration || value.accountIdentity !== params.accountIdentity)) this.invalid(true);
    return value;
  }
  async directoryPage(operationId, offset = 0) {
    if (!this.ready || !key(operationId) || !uint(0, 10000)(offset)) throw new NativeRequestError('invalid_request');
    const value = await this.request('directory.page', { operationId, offset }, record({ directory: directoryShape, items: list(targetShape, 100), nextOffset: nullable(uint(0, 10000)) }));
    if (value.directory.operationId !== operationId || value.directory.phase !== 'ready' || !value.directory.snapshotAvailable || value.nextOffset !== null && value.nextOffset !== offset + value.items.length ||
        value.items.some(item => (item.kind === 'group') !== item.id.endsWith('@chatroom')) || new Set(value.items.map(item => item.id)).size !== value.items.length) this.invalid();
    return value;
  }
  async pull(identity) {
    if (!this.ready || !uint(1)(identity.accountGeneration) || !coordinate(identity.accountIdentity)) throw new NativeRequestError('invalid_request');
    const value = await this.request('sync.pull', { accountGeneration: identity.accountGeneration, accountIdentity: identity.accountIdentity },
      record({ accountGeneration: uint(1), checkpoint: uint(), eventCursor: cursor, more: bool, retainedUnprojected: uint() }));
    if (value.accountGeneration !== identity.accountGeneration) this.invalid(); return value;
  }
  async events(accountId, after = '0') {
    this.accountId(accountId); if (!this.ready || !cursor(after)) throw new NativeRequestError('invalid_request');
    const value = await this.request('events.page', { accountGeneration: this.account.accountGeneration, after }, record({ items: list(eventShape, 100), nextCursor: cursor, more: bool }));
    let previous = BigInt(after);
    for (const item of value.items) { if (BigInt(item.cursor) <= previous) this.invalid(); previous = BigInt(item.cursor); }
    if (BigInt(value.nextCursor) !== previous || value.more && !value.items.length) this.invalid();
    return { ...value, items: value.items.map(event => ({ cursor: event.cursor, kind: 'message.committed', createdAt: new Date(event.createdAt * 1000).toISOString(), data: { messageId: event.messageId, threadId: event.threadId } })) };
  }
  async message(accountId, messageId) {
    this.accountId(accountId); if (!this.ready || !coordinate(messageId)) throw new NativeRequestError('invalid_request');
    const value = await this.request('message.get', { accountGeneration: this.account.accountGeneration, messageId }, messageShape);
    if (value.id !== messageId || value.accountIdentity !== this.account.accountIdentity) this.invalid();
    return { id: value.id, accountId, accountIdentity: value.accountIdentity, threadId: value.threadId, senderId: value.senderId, direction: value.direction,
      serverId: value.serverId, body: value.body, createdAt: new Date(value.createdAt * 1000).toISOString() };
  }
}
