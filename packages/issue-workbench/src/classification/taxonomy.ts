/** One vocabulary for human choices, grouping and cat instructions. Names keep existing assignment rules compatible. */
export const issueCategories = [
  { id: 'agent-runtime', label: 'Agent 运行', includes: '单只猫的模型调用、对话执行、输出流、超时或进程退出。', excludes: '猫间交接归猫猫协作；外部工具调用归工具与连接器。', example: '升级成功后无法对话，仍按对话受阻归这里。' },
  { id: 'interface', label: '界面交互', includes: '页面布局、输入、点击、滚动、可访问性或显示反馈。', excludes: '消息送错猫归猫猫协作；模型执行状态异常归 Agent 运行。不能仅因在页面看到就归这里。', example: '输入框溢出、按钮遮挡或页面跳动。' },
  { id: 'context-memory', label: '上下文与记忆', includes: '对话历史、上下文压缩、记忆保存、召回和检索。', excludes: '跨猫消息路由归猫猫协作；账号或偏好保存归配置同步。', example: '重开会话丢失上下文，或检索不到已保存的记忆。' },
  { id: 'collaboration', label: '猫猫协作', includes: '猫间传球、唤醒、任务分派、责任接手和协作状态。', excludes: '单猫自身调用失败归 Agent 运行；外部 IM 收发归工具与连接器。', example: '@ 已发出但目标猫没有收到任务。' },
  { id: 'tools-connectors', label: '工具与连接器', includes: '工具、MCP、浏览器或外部平台的调用、数据传输与收发。', excludes: '插件装载/启停归插件生命周期；账号配置不能保存归配置同步。', example: '工具返回失败，或已接入的飞书收不到消息。' },
  { id: 'installation-build', label: '安装与构建', includes: '产品依赖安装、编译打包、部署、升级执行和服务启动。', excludes: '安装成功后的业务故障按受阻能力分类；测试、PR、合入流程归代码与交付。', example: 'pnpm install 失败，或构建产物无法启动。' },
  { id: 'plugin-lifecycle', label: '插件生命周期', includes: '插件发现、安装、启用、停用、升级、卸载和能力注册。', excludes: '宿主产品的安装归安装与构建；插件启用后某项工具失败归工具与连接器。', example: '插件已安装却不能启用，或停用后仍残留工具。' },
  { id: 'configuration-sync', label: '配置同步', includes: '账号授权、凭据、设置的读取、保存、迁移或跨端同步。', excludes: '记忆和聊天历史归上下文与记忆；已有有效配置下的调用失败按受阻能力分类。', example: '保存模型配置后丢失，或凭据同步失败。' },
  { id: 'repository-delivery', label: '代码与交付', includes: 'Git、工位、代码修改、开发测试、CI、PR、review 和合入流程。', excludes: '面向使用者的产品安装/编译归安装与构建；业务功能失败按其能力分类。', example: '测试入口在 PowerShell 不能运行，或 PR 门禁状态错误。' },
  { id: 'product-documentation', label: '产品与文档', includes: '文档错误或缺失、产品入口说明、跨能力的使用指导。', excludes: '具体功能的新需求按所属能力分类，并标为功能需求；不能将所有需求兜进这里。', example: '安装文档给出错误路径；若是命令本身失败则归安装与构建。' },
  { id: 'unclear', label: '待判断', includes: '证据不足、没有适用类别，或多个同等独立问题暂不能确定主诉求。', excludes: '不猜根因、不因关键词强选；补充说明后再选类。', example: '只有“不能用”，或同时报告两个无主次的独立故障。' },
] as const;

export function categoryDefinition(value: string) {
  return issueCategories.find(category => category.label === value || category.id === value
    || (category.id === 'unclear' && value === '待澄清'));
}
export function primaryCategory(areas: string[] = []): string {
  const labels = [...new Set(areas.map(area => categoryDefinition(area)?.label ?? '待判断'))];
  return labels.length === 1 ? labels[0] : '待判断';
}
export const categoryDecisionRule = '按报告明确受阻的能力或主要诉求选择一个问题类别，不按出现的关键词猜根因。多个同等独立问题、证据不足或无适用项时选待判断；已有 Feature 绑定优先随 Feature 处理。';
export const categoryInstructions = `${categoryDecisionRule}\ncategory 仅从以下名称中选一个；来源、系统、类型、现象不作为主类别，也不自造同义名称。\n${issueCategories.map(item => `${item.label}：${item.includes} 不含：${item.excludes} 例如：${item.example}`).join('\n')}`;
