import { randomBytes } from 'node:crypto';
import { fail } from './config.mjs';
import { body, requireToken, send } from './http.mjs';
import { configurationLock } from './private-config.mjs';
import { checkProjectInput } from './server-projects.mjs';
import { createTransfer, packageSummary } from './transfer-package.mjs';
import { transferPreflight } from './transfer-preflight.mjs';
import { pauseTransferredRun, saveTransferState, transferState } from './transfer-state.mjs';

const limit = 128 * 1024 * 1024;
export async function transferRequest(request, response, path, context, token) {
  if (!path.startsWith('/api/transfers/')) return false;
  requireToken(request, token);
  if (request.method !== 'POST') {
    send(response, 404, { code: 'NOT_FOUND' });
    return true;
  }
  const { options, tasks } = context;
  const workspace = options.projects?.transfers;
  if (!workspace) fail('TRANSFER_WORKSPACE_REQUIRED', '请从 setup / serve 正式多项目工作台使用导入导出。');
  if (path === '/api/transfers/preview') {
    send(response, 200, await workspace.preview(await packageBody(request)));
    return true;
  }
  const input = await body(request);
  checkProjectInput(input, options.projectId);
  if (path === '/api/transfers/recover-registration') {
    if (Object.keys(input).some((key) => !['projectId', 'confirmWritersStopped'].includes(key)))
      fail('TRANSFER_INPUT_INVALID', '登记锁恢复不能指定路径或进程。');
    send(response, 200, await workspace.recoverRegistration(input));
    return true;
  }
  if (path === '/api/transfers/import') {
    send(response, 200, await workspace.install(input));
    return true;
  }
  if (!['/api/transfers/export', '/api/transfers/check', '/api/transfers/activate'].includes(path)) {
    send(response, 404, { code: 'NOT_FOUND' });
    return true;
  }
  const connection = options.connection;
  if (!connection) fail('CONFIGURATION_REQUIRED', '请先选择项目。');
  const allowed = [
    'projectId',
    'expectedRevision',
    'expectedBinding',
    ...(path.endsWith('/export') ? ['kind'] : []),
    ...(path.endsWith('/activate') ? ['confirmSingleWriter'] : []),
  ];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    fail('TRANSFER_INPUT_INVALID', '迁移操作参数无效，未开始同步。');
  const value = await configurationLock(connection.describe().configurationFile, async () => {
    assertIdle(tasks);
    const receiver = await connection.current();
    if (
      !receiver ||
      input.expectedRevision !== connection.describe().revision ||
      input.expectedBinding !== receiver.config.bindingId
    )
      fail('CONFIGURATION_CHANGED', '项目或配置已变化，请刷新后再导入导出；未操作其他项目。');
    return receiver.store.locked(async () => {
      if (path.endsWith('/export')) return exportProject(receiver, input, context);
      const transfer = await transferState(receiver.config);
      if (!transfer) fail('TRANSFER_NOT_FOUND', '此项目没有待处理的迁移，请先导入文件。');
      if (path.endsWith('/activate') && input.confirmSingleWriter !== true)
        fail('TRANSFER_WRITER_CONFIRMATION', '请确认原环境与接收环境只有一个执行器会继续此接收分支。');
      const checks = await transferPreflight(receiver, options.transferChecks);
      transfer.checks = checks;
      transfer.checkedAt = new Date().toISOString();
      const passed = checks.every((item) => item.status === 'PASSED');
      if (path.endsWith('/activate') && passed) {
        transfer.status = 'ACTIVE';
        transfer.activatedAt = transfer.checkedAt;
      }
      await saveTransferState(receiver.config, transfer);
      return { transfer, activated: path.endsWith('/activate') && passed };
    });
  });
  if (path.endsWith('/export'))
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="repo-sync-${input.kind}-${value.packageId.slice(0, 12)}.json"`,
    );
  send(response, 200, value);
  return true;
}

function assertIdle(tasks) {
  if (tasks.busy() || tasks.admitting)
    fail('OPERATION_RUNNING', '当前任务仍在执行。请等待执行记录保存完成，再导出或启用迁移；不用取消原交付。');
}
async function exportProject(receiver, input, context) {
  if (!['template', 'migration'].includes(input.kind)) fail('TRANSFER_KIND_INVALID', '请选择配置模板或完整迁移包。');
  const last = await context.tasks.latest();
  if (['RUNNING', 'CANCELLING', 'STOP_UNCONFIRMED'].includes(last?.status) || last?.persistence?.status === 'FAILED')
    fail('TRANSFER_TASK_UNSETTLED', '原任务尚未安全结束，请先恢复原执行记录或确认中断进程，再导出。');
  const project = (await context.options.workspace()).projects.find((item) => item.id === context.options.projectId);
  if (input.kind === 'migration') {
    const state = await receiver.read();
    if (!state) fail('TRANSFER_BASELINE_REQUIRED', '尚未登记同步起点，请导出配置模板；完整迁移包需要已有台账。');
    const held = {
      packageId: randomBytes(32).toString('hex'),
      kind: 'migration',
      status: 'EXPORTED',
      exportedAt: new Date().toISOString(),
      projectId: project.id,
    };
    await saveTransferState(receiver.config, held);
    pauseTransferredRun(state);
    await receiver.store.save(state);
    assertIdle(context.tasks);
  }
  const pkg = await createTransfer(receiver, { kind: input.kind, projectId: project.id, name: project.name });
  if (input.kind === 'migration')
    await saveTransferState(receiver.config, {
      ...(await transferState(receiver.config)),
      packageId: pkg.packageId,
      summary: packageSummary(pkg),
    });
  return pkg;
}
async function packageBody(request) {
  const declared = Number(request.headers['content-length']);
  if (declared > limit) fail('BODY_TOO_LARGE', '迁移文件超过 128 MiB，未导入。');
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) fail('BODY_TOO_LARGE', '迁移文件超过 128 MiB，未导入。');
    chunks.push(chunk);
  }
  if (request.aborted || !request.complete)
    fail('TRANSFER_UPLOAD_INTERRUPTED', '文件上传中断，请重新选择同一文件；没有登记新项目。');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('TRANSFER_PACKAGE_INVALID', '文件不是完整的迁移 JSON，请重新下载或选择原文件。');
  }
}
