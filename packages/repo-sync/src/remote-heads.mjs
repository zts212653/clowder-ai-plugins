import { fail } from './config.mjs';
import { phase } from './execution.mjs';
import { command, gitEnvironment } from './process.mjs';

export async function remoteHeads(config) {
  const result = {};
  for (const [side, key, url, branch, label] of [
    ['source', 'upstream', config.sourceUrl, config.sourceBranch, '检查外部连接与分支'],
    ['internal', 'internal', config.internalUrl, config.targetBranch, '检查内部连接与分支'],
  ]) {
    result[key] = await phase(`${side}-probe`, label, async () => {
      const ref = `refs/heads/${branch}`;
      let text;
      try {
        text = await command('git', ['ls-remote', '--exit-code', url, ref], {
          env: gitEnvironment(),
          timeout: config.timeouts?.probe ?? 20000,
        });
      } catch (error) {
        if (error.code === 'COMMAND_FAILED' && error.details?.exitCode === 2)
          fail('REMOTE_BRANCH_MISSING', `${side === 'source' ? '外部' : '内部'}仓库不存在指定分支，请核对仓库设置`);
        throw error;
      }
      return parseHead(text, ref);
    });
  }
  return result;
}
function parseHead(text, ref) {
  const matches = text
    .split('\n')
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts[1] === ref);
  if (matches.length !== 1 || !/^[a-f0-9]{40}$/.test(matches[0][0]))
    fail('REMOTE_HEAD_INVALID', '远端分支返回的提交格式不受支持，请核对仓库与 Git 对象格式');
  return matches[0][0];
}
