import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fail } from './config.mjs';

const pending = new Map();
const messages = {
  LEDGER_WRITE_FAILED:
    '台账无法保存：短暂文件占用重试后仍失败。请关闭占用台账的程序并核对目录写权限，再刷新回读台账与 Git 结果；未确认前不要重发同步。原台账未被删除或截断。',
  PRIVATE_WRITE_FAILED:
    '本机配置或执行记录无法保存：请关闭占用文件的程序并核对目录写权限，再回读当前配置与台账。原文件未被删除或截断，不要重复发起同步。',
};
function coordinated(file, operation) {
  const path = resolve(file);
  const key = process.platform === 'win32' ? path.toLowerCase() : path;
  const result = (pending.get(key) ?? Promise.resolve()).then(operation);
  const tail = result.catch(() => {});
  pending.set(key, tail);
  return result.finally(() => {
    if (pending.get(key) === tail) pending.delete(key);
  });
}
export function readText(file) {
  return coordinated(file, () => fs.readFile(file, 'utf8'));
}
async function replace(temporary, file) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.rename(temporary, file);
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 6) throw error;
      await delay(Math.min(20 * 2 ** attempt, 400));
    }
  }
}
export function writeJson(file, value, code = 'PRIVATE_WRITE_FAILED') {
  return coordinated(file, async () => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    let handle;
    let owned = false;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      owned = true;
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.close();
      handle = null;
      await replace(temporary, file);
    } catch {
      fail(code, messages[code]);
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (owned) await fs.unlink(temporary).catch(() => {});
    }
  });
}
