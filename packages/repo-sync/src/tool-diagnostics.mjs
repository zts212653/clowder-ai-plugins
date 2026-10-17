import { stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { fail } from './config.mjs';

export async function checkCommandDirectory(directory) {
  try {
    if (!(await stat(directory ?? process.cwd())).isDirectory()) throw Error('not a directory');
  } catch {
    fail(
      'WORKING_DIRECTORY_UNAVAILABLE',
      '执行工作目录不存在、不是目录或无法访问。请恢复原私有目录或核对检查命令的 cwd；这不是 Git 账号或工具安装问题，原台账保留。',
    );
  }
}
const tool = (value = '') =>
  win32
    .basename(posix.basename(value))
    .replace(/\.exe$/i, '')
    .toLowerCase();
export function startupFailure(code, executable) {
  const name = tool(executable);
  if (code === 'ENOENT') {
    if (name === 'gh')
      fail(
        'COMMAND_NOT_FOUND',
        '当前服务无法启动 GitHub CLI（gh）。Git 已有账号不代表此工具可用。在启动服务的同一 Windows 终端运行 where.exe gh、gh --version；安装或修正 PATH 后重新启动服务。GitHub 读取登录与 Git 代码认证是两回事。',
      );
    if (name === 'git')
      fail(
        'COMMAND_NOT_FOUND',
        '当前服务无法启动 Git。请在启动服务的同一 Windows 终端运行 where.exe git、git --version；安装 Git 或修正 PATH 后重新启动服务。Git 账号不能替代可执行工具。',
      );
    fail(
      'COMMAND_NOT_FOUND',
      '当前服务无法启动私有检查或平台适配工具。请在本机私有配置核对 command、工具安装及服务 PATH；不能把整条命令连同参数写进 command。恢复工具后重试原任务。',
    );
  }
  if (['EACCES', 'EPERM'].includes(code))
    fail(
      'COMMAND_PERMISSION_DENIED',
      '执行工具被系统拒绝启动。请核对工具的执行权限及安全软件策略，再恢复原任务；不要关闭系统保护。',
    );
}
export function githubCommandFailure(stderr, executable) {
  if (tool(executable) !== 'gh') return;
  if (/gh auth login|not logged into|HTTP.*\b401\b/i.test(stderr))
    fail(
      'GITHUB_AUTH_REQUIRED',
      'GitHub CLI 读取认证未配置或已失效。请在启动服务的同一终端运行 gh auth status --hostname github.com，必要时 gh auth login --hostname github.com；Git 登录与 GitHub API 读取认证独立。',
    );
}
