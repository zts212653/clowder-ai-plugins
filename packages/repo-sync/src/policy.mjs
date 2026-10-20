import { fail } from './config.mjs';

export function versionPolicy(input) {
  if (input.mergePaths !== undefined && (!Array.isArray(input.mergePaths) || input.mergePaths.length))
    fail(
      'UNSUPPORTED_MERGE_POLICY',
      '当前版本不支持共同文件三方合并。保留原配置与台账；未启用项目请明确选择整文件内部保留，或先通过内部 PR 对齐核心文件。已有交付请先用原版本处理完成，再核对新基线，不能直接改写已启用规则。',
    );
  const policy = { internalPaths: input.internalPaths ?? [] };
  const all = [];
  for (const paths of Object.values(policy)) {
    if (!Array.isArray(paths) || paths.length > 100) fail('INVALID_POLICY', '文件规则必须是最多 100 项的路径列表');
    for (const path of paths) {
      const root = validatePath(path);
      if (all.some((other) => root === other || root.startsWith(`${other}/`) || other.startsWith(`${root}/`)))
        fail('INVALID_POLICY', '文件规则不可重复或重叠');
      all.push(root);
    }
  }
  return { internalPaths: [...policy.internalPaths].sort(), mergePaths: [] };
}
function validatePath(path) {
  if (
    typeof path !== 'string' ||
    !path ||
    /[\\:*?<>|"]/.test(path) ||
    path.startsWith('/') ||
    [...path].some((char) => char.charCodeAt(0) < 32)
  )
    fail('INVALID_POLICY', '只支持相对文件路径或以 / 结尾的目录，不能使用通配符或绝对路径');
  const root = path.replace(/\/$/, '');
  if (root.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git'))
    fail('INVALID_POLICY', '文件规则包含危险或无效路径');
  return root;
}
export function matches(path, rule) {
  const root = rule.replace(/\/$/, '');
  return path === root || (rule.endsWith('/') && path.startsWith(`${root}/`));
}
export function category(path, policy) {
  if (policy.internalPaths.some((rule) => matches(path, rule))) return 'internal';
  return 'upstream';
}
