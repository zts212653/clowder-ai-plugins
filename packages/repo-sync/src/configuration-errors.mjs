import { fail } from './config.mjs';

const messages = {
  internal: {
    head: 'I0 应填写内部合入分支的当前 HEAD，而不是第一次同步时的历史提交。点击“读取两侧当前版本”会填入最新 I0；外部 U0 保持上次已同步版本。内部专项改动须先声明保留路径，核心差异会继续核验。',
  },
  issueApiUrl: {
    url: '请填写完整 API 基础地址，例如 https://api.example/api/v4；项目路径请填在“API 项目 ID / 路径”，这里不能只填项目路径。',
    https: 'API 基础地址需要以 https:// 开头；不能用 HTTP 地址发送 Token。',
    credentials: 'API 地址不能包含用户名、密码、Token、查询参数或 # 片段；凭据请使用下方 Token 设置。',
    root: '这里只填 API 基础地址，末尾为 /api/v4；若粘贴了调用地址，请去掉后面的 /projects/…/issues 等资源路径。',
  },
  issueProjectId: {
    path: '填写数字项目 ID 或项目路径（例如 team/core），不能填写完整网页地址；也可留空，从同一仓库的 Issue 链接生成。',
  },
  issueAuthMode: { mode: '请选择“直接输入 Token”或“使用环境变量”。' },
  issueTokenEnv: {
    name: '这里填写变量名称，例如 REPO_SYNC_INTERNAL_TOKEN，不能填 Token 本身、$ 或等号；若要粘贴 Token，请改选“直接输入 Token”。',
  },
  issueMode: { mode: '请选择 Issue 创建方式；命令适配器需在本机私有配置中接入。' },
  internalWebUrl: {
    url: '请填写内部仓库首页的完整 HTTPS 网页地址，用于核对 PR 和 Issue 归属；不要填写 Git 克隆地址或 Issue 列表地址。',
  },
  issuePageUrl: {
    url: '请填写内部仓库的 HTTPS Issue 列表或具体 Issue 网页链接，不能包含凭据或查询参数。',
    repository:
      'Issue 网页链接必须属于上面填写的内部仓库；支持 /issues、/issues/编号、/-/issues 路径。请核对仓库首页和 Issue 链接。',
  },
};

export function publicFieldErrors(fields) {
  if (!Array.isArray(fields)) return [];
  return fields.slice(0, 12).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const { field, reason } = entry;
    const message =
      Object.hasOwn(messages, field ?? '') && Object.hasOwn(messages[field], reason ?? '')
        ? messages[field][reason]
        : null;
    return message ? [{ field, reason, message }] : [];
  });
}
export function configurationErrors(entries, code = 'INVALID_ISSUE_CONFIG') {
  const fields = publicFieldErrors(entries.map(([field, reason]) => ({ field, reason })));
  fail(code, fields[0].message, { fields });
}
