import { readFile, unlink } from 'node:fs/promises';
import { fail } from './config.mjs';
import { privateLocation } from './private-config.mjs';

// The caller selects its own registry path. Web requests must never supply a filesystem path.
export async function recoverRegistrationLock(configurationFile, options = {}) {
  if (options?.confirmWritersStopped !== true)
    fail(
      'CONFIGURATION_WRITERS_NOT_CONFIRMED',
      '请先确认旧服务以及它启动的 Git、检查和平台子进程均已退出，再明确恢复登记锁；不会按等待时长接管。',
    );
  const configuration = await privateLocation(configurationFile);
  const lock = await privateLocation(`${configuration}.lock`);
  let original;
  try {
    original = await readFile(lock, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { recovered: false };
    fail('CONFIGURATION_LOCK_UNREADABLE', '无法读取原登记锁，请核对本机目录权限与文件占用；原配置和台账保留。');
  }
  let owner;
  try {
    owner = JSON.parse(original);
  } catch {
    invalidLock();
  }
  if (
    !owner ||
    typeof owner !== 'object' ||
    Array.isArray(owner) ||
    Object.keys(owner).some((key) => key !== 'pid') ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0
  )
    invalidLock();
  let stopped = false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') stopped = true;
    else writerAlive();
  }
  if (!stopped) writerAlive();
  let current;
  try {
    await privateLocation(lock);
    current = await readFile(lock, 'utf8');
  } catch {
    changedLock();
  }
  if (current !== original) changedLock();
  try {
    await unlink(lock);
  } catch (error) {
    if (error.code === 'ENOENT') changedLock();
    fail(
      'CONFIGURATION_LOCK_RELEASE_FAILED',
      '原登记锁暂时无法释放。请核对文件占用和目录权限后重试；没有删除配置或同步历史。',
    );
  }
  return { recovered: true };
}
function invalidLock() {
  fail(
    'CONFIGURATION_LOCK_INVALID',
    '原登记锁内容损坏或缺少有效进程身份，不能猜测接管。请在本机核对旧执行器与锁文件；原记录保留。',
  );
}
function writerAlive() {
  fail(
    'CONFIGURATION_WRITER_ALIVE',
    '原登记执行器仍存在，或当前服务无法确认它已退出。请停止原服务及其子进程后再恢复；原锁保留。',
  );
}
function changedLock() {
  fail('LOCK_OWNER_CHANGED', '核验期间登记锁已变化，未释放。请刷新状态并重新核对当前执行器，避免打断新的登记操作。');
}
