import { randomUUID } from 'node:crypto';
import { link, lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';

const SOCKET_PROBE_TIMEOUT_MS = 1_000;
const heldSocketLeases = new WeakMap();

function sameSocketIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

async function readLease(lockPath) {
  const identity = await lstat(lockPath);
  let owner;
  try {
    owner = JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    throw new Error(`cannot verify native host socket owner: ${lockPath}`);
  }
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || typeof owner.token !== 'string') {
    throw new Error(`cannot verify native host socket owner: ${lockPath}`);
  }
  return { identity, owner };
}

async function removeDeadLease(lockPath, label) {
  let observed;
  try {
    observed = await readLease(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (processIsAlive(observed.owner.pid)) {
    throw new Error(`${label} already has a live owner: ${lockPath.slice(0, -'.owner'.length)}`);
  }
  let current;
  try {
    current = await lstat(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!sameSocketIdentity(observed.identity, current)) return false;
  await unlink(lockPath);
  return true;
}

export async function acquireProcessLease(resourcePath, { label = 'resource' } = {}) {
  const lockPath = `${resourcePath}.owner`;
  const token = randomUUID();
  const candidatePath = `${lockPath}.${process.pid}.${token}`;
  await writeFile(candidatePath, `${JSON.stringify({ pid: process.pid, token })}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  try {
    for (;;) {
      try {
        await link(candidatePath, lockPath);
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        await removeDeadLease(lockPath, label);
      }
    }
  } finally {
    await unlink(candidatePath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }

  return {
    async release() {
      let lease;
      try {
        lease = await readLease(lockPath);
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
      }
      if (lease.owner.token !== token) return;
      await unlink(lockPath);
    },
  };
}

export async function acquireSocketLease(socketPath) {
  const processLease = await acquireProcessLease(socketPath, { label: 'socket' });
  const lease = {
    async release() {
      heldSocketLeases.delete(lease);
      await processLease.release();
    },
  };
  return lease;
}

/** Only an unreleased, inactive-socket fence can be reused by a nested mutation. */
export function assertInactiveSocketLeaseHeld(lease, socketPath) {
  if (heldSocketLeases.get(lease) !== socketPath) throw new Error('invalid held socket lease');
}

/** Shares the helper's original fence, including helpers from earlier packages. */
export async function acquireInactiveSocketLease(socketPath) {
  const lease = await acquireSocketLease(socketPath);
  try {
    let socket;
    try { socket = await lstat(socketPath); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (socket) throw new Error('personal Chrome helper is active; stop Chrome before setup');
    heldSocketLeases.set(lease, socketPath);
    return lease;
  } catch (error) {
    await lease.release();
    throw error;
  }
}

async function socketIdentity(socketPath) {
  const info = await lstat(socketPath);
  if (!info.isSocket()) throw new Error(`refusing to replace non-socket path: ${socketPath}`);
  return { dev: info.dev, ino: info.ino };
}

function socketHasLiveOwner(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let settled = false;
    const finish = (error, live) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(live);
    };
    socket.once('connect', () => finish(undefined, true));
    socket.on('error', (error) => {
      if (error?.code === 'ECONNREFUSED' || error?.code === 'ENOENT') finish(undefined, false);
      else finish(error);
    });
    socket.setTimeout(SOCKET_PROBE_TIMEOUT_MS, () => {
      finish(new Error(`timed out probing native host socket: ${socketPath}`));
    });
  });
}

export async function prepareSocketPath(socketPath) {
  let observedIdentity;
  try {
    observedIdentity = await socketIdentity(socketPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }

  if (await socketHasLiveOwner(socketPath)) {
    throw new Error(`socket already has a live owner: ${socketPath}`);
  }

  let currentIdentity;
  try {
    currentIdentity = await socketIdentity(socketPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!sameSocketIdentity(observedIdentity, currentIdentity)) {
    throw new Error(`socket owner changed while probing: ${socketPath}`);
  }
  await unlink(socketPath);
}
