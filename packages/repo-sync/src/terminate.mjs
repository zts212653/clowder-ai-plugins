import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fail } from './config.mjs';

const execute = promisify(execFile);
export async function terminateTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // Only our live child PID is passed; no shell or caller-supplied command text.
    await execute('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }).catch(
      () => fail('STOP_UNCONFIRMED', '无法确认执行进程树已停止；保留执行锁，请在本机确认后恢复'),
    );
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') fail('STOP_UNCONFIRMED', '无法确认执行进程组已停止；保留执行锁');
    }
  }
}
