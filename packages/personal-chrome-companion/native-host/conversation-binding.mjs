import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

const RECORD_FIELDS = new Set(['schemaVersion', 'provider', 'conversationId', 'chatUrl', 'boundAt', 'updatedAt']);
const CONVERSATION_ID = /^[A-Za-z0-9-]{1,200}$/;
const MAX_RECORD_BYTES = 4 * 1024;

export class PersonalChromeConversationBindingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PersonalChromeConversationBindingError';
    this.code = code;
  }
}

function requireExactString(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} must be a non-empty exact string`);
  }
  return value;
}

function requireAbsolutePath(value, field) {
  requireExactString(value, field);
  if (!isAbsolute(value)) throw new Error(`${field} must be absolute`);
  return value;
}

function requireIsoTimestamp(value, field) {
  requireExactString(value, field);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${field} must be a canonical ISO timestamp`);
  }
  return value;
}

export function conversationIdFromExactChatGptUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' || url.search || url.hash) return null;
    return url.pathname.match(/^\/c\/([A-Za-z0-9-]{1,200})\/?$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function validatePersonalChromeConversationBinding(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('conversation binding must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!RECORD_FIELDS.has(key)) throw new Error(`conversation binding has unknown field: ${key}`);
  }
  for (const field of RECORD_FIELDS) {
    if (!Object.hasOwn(value, field)) throw new Error(`conversation binding is missing field: ${field}`);
  }
  if (value.schemaVersion !== 1) throw new Error('schemaVersion must equal 1');
  if (value.provider !== 'chatgpt') throw new Error('provider must equal chatgpt');
  if (typeof value.conversationId !== 'string' || !CONVERSATION_ID.test(value.conversationId)) {
    throw new Error('conversationId has an invalid format');
  }
  const urlConversationId = conversationIdFromExactChatGptUrl(value.chatUrl);
  if (!urlConversationId) throw new Error('chatUrl must be an exact https://chatgpt.com/c/<id> URL');
  if (urlConversationId !== value.conversationId) throw new Error('chatUrl must match conversationId');
  requireIsoTimestamp(value.boundAt, 'boundAt');
  requireIsoTimestamp(value.updatedAt, 'updatedAt');
  return {
    schemaVersion: 1,
    provider: 'chatgpt',
    conversationId: value.conversationId,
    chatUrl: value.chatUrl,
    boundAt: value.boundAt,
    updatedAt: value.updatedAt,
  };
}

export async function readPersonalChromeConversationBinding(path) {
  requireAbsolutePath(path, 'conversationBindingPath');
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new PersonalChromeConversationBindingError('NEEDS_BINDING', 'bind one ChatGPT conversation explicitly');
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('conversation binding must be a regular file');
  if ((metadata.mode & 0o777) !== 0o600) throw new Error('conversation binding must have mode 0600');
  if (metadata.size > MAX_RECORD_BYTES) throw new Error('conversation binding exceeds size limit');
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`conversation binding is unreadable: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  return validatePersonalChromeConversationBinding(parsed);
}

export async function writePersonalChromeConversationBindingAtomic(path, value, options = {}) {
  requireAbsolutePath(path, 'conversationBindingPath');
  const record = validatePersonalChromeConversationBinding(value);
  const payload = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(payload, 'utf8') > MAX_RECORD_BYTES) throw new Error('conversation binding exceeds size limit');
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  const temporaryPath = resolve(parent, `.${randomUUID()}.conversation-binding.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o600);
    await (options.renameFile ?? rename)(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return record;
}
