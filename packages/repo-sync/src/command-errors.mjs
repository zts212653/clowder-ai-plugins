import { fail } from './config.mjs';
import { githubCommandFailure, startupFailure } from './tool-diagnostics.mjs';

const reasons = [
  [
    /does not support push options|push options are not supported/i,
    'GIT_PR_UNSUPPORTED',
    '内部 Git 服务不支持配置的 PR 创建扩展；未改成手工创建，请核对平台的实际 Git 创建方式',
  ],
  [
    /REMOTE HOST IDENTIFICATION HAS CHANGED/i,
    'SSH_HOST_KEY_CHANGED',
    'SSH 主机密钥发生变化，请在本机核对可信指纹后处理已保存的主机记录',
  ],
  [
    /Host key verification failed/i,
    'SSH_HOST_KEY_FAILED',
    'SSH 主机密钥校验未通过，请在本机终端核对可信指纹并完成首次连接，再重新检查',
  ],
  [
    /Permission denied \([^)]*(publickey|password|keyboard-interactive)/i,
    'SSH_AUTH_FAILED',
    'SSH 认证失败，请在本机检查密钥、ssh-agent 和仓库访问权限',
  ],
  [
    /Authentication failed|could not read Username|terminal prompts disabled|HTTP.*\b401\b/i,
    'HTTPS_AUTH_FAILED',
    'HTTPS 认证未完成，请在本机终端配置 Git 凭据后重新检查',
  ],
  [
    /repository.*not found|does not appear to be a git repository|HTTP.*\b403\b/i,
    'REPOSITORY_UNAVAILABLE',
    '仓库不可访问，请核对地址和读取权限',
  ],
  [
    /Could not resolve (host|hostname)|Connection refused|Network is unreachable|Connection timed out|Failed to connect/i,
    'NETWORK_FAILED',
    '网络连接失败，请在本机核对 DNS、网络通道及远端服务',
  ],
];
export function commandFailure(stderr, code, executable) {
  startupFailure(code, executable);
  githubCommandFailure(stderr, executable);
  for (const [pattern, reason, message] of reasons) if (pattern.test(stderr)) fail(reason, message);
  fail('COMMAND_FAILED', `命令执行失败，退出状态 ${Number.isInteger(code) ? code : '未知'}。请在本机核对原始输出`, {
    exitCode: code,
  });
}
