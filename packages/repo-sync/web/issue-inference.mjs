export function updateIssueInference(form) {
  const output = form?.querySelector('[data-issue-inference]');
  if (!output) return;
  const value = (name) => form.elements.namedItem(name)?.value.trim() ?? '';
  try {
    const page = new URL(value('issuePageUrl') || `${value('internalWebUrl').replace(/\/$/, '')}/issues`),
      project = page.pathname.replace(/\/(?:-\/)?issues(?:\/\d+)?\/?$/, ''),
      web = new URL(value('internalWebUrl') || `${page.origin}${project}`);
    if (
      page.protocol !== 'https:' ||
      page.username ||
      page.password ||
      page.search ||
      page.hash ||
      project === page.pathname ||
      page.origin !== web.origin ||
      project !== web.pathname.replace(/\/$/, '')
    )
      throw Error();
    const api = value('issueApiUrl') || `${page.origin}/api/v4`,
      path = value('issueProjectId') || decodeURIComponent(project.replace(/^\//, '')),
      url = new URL(api);
    if (url.username || url.password || url.search || url.hash || !/^[\w./%-]+$/.test(path)) throw Error();
    output.textContent = `${value('issueApiUrl') || value('issueProjectId') ? '高级覆盖与链接推导' : value('issuePageUrl') ? '由 Issue 页面推导' : '由仓库首页推导'}：仓库 ${web.origin}${project}；API 基础地址 ${api}；项目 ID / 路径 ${path}。保存后进行只读检查；推导不证明协议兼容或写权限。`;
  } catch {
    output.textContent =
      '填写同一内部仓库的 Issue 链接后，可自动推断 API 地址和项目路径；已有数字项目 ID 或独立 API 域名时，展开高级设置填写。推断结果需在保存后进行只读核验。';
  }
}
