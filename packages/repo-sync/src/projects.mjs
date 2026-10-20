import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fail } from './config.mjs';
import { createConnection } from './connections.mjs';
import { safeError } from './execution.mjs';
import { readPrivate } from './private-config.mjs';
import { projectRegistry, validProjectId } from './project-registry.mjs';
import { transferWorkspace } from './transfer-workspace.mjs';
import { receivingRepositoryKey } from './repository-identity.mjs';

export async function createProjectWorkspace(file, options = {}) {
  const registry = await projectRegistry(file),
    connections = new Map();
  async function get(id = 'default') {
    if (!validProjectId(id)) fail('PROJECT_NOT_FOUND', '项目身份无效，未操作默认或其他项目');
    const saved = await registry.read(),
      entry = saved.value.projects.find((item) => item.id === id);
    if (!entry) fail('PROJECT_NOT_FOUND', '这个项目不在当前工作台，未操作其他项目');
    const path = registry.configuration(id);
    if (entry.configured && !(await readPrivate(path)).config)
      fail('PROJECT_CONFIGURATION_MISSING', '已登记项目的配置丢失，请恢复原配置文件；不能当成空白项目');
    if (!connections.has(id)) {
      const connection = await createConnection(
        path,
        id === 'default'
          ? {}
          : {
              stateDirectory: (bindingId) =>
                join(
                  dirname(registry.root),
                  `sync-${createHash('sha256').update(`${registry.root}:${id}:${bindingId}`).digest('hex').slice(0, 24)}`,
                ),
            },
      );
      const scoped = {
        id,
        current: () => connection.current(),
        describe: () => ({ ...connection.describe(), projectId: id }),
        run: async (input, options) => {
          if (input.projectId && input.projectId !== id)
            fail('PROJECT_CHANGED', '请求项目与实际项目不一致，业务未执行');
          const { projectId: _projectId, ...value } = input;
          if (value.action !== 'configure-repositories') return connection.run(value, options);
          return registry.locked(async () => {
            await destinationAvailable(id, value);
            const result = await connection.run(value, options);
            const latest = await registry.read();
            latest.value.projects.find((item) => item.id === id).configured = true;
            await registry.save(latest.value);
            return result;
          });
        },
      };
      connections.set(id, scoped);
    }
    return connections.get(id);
  }
  async function destinationAvailable(id, input) {
    const saved = await registry.read();
    for (const entry of saved.value.projects) {
      if (entry.id === id) continue;
      const config = (await readPrivate(registry.configuration(entry.id))).config;
      if (entry.configured && !config)
        fail('PROJECT_CONFIGURATION_MISSING', '另一项目配置缺失，无法证明接收范围互不冲突；请先恢复原配置');
      if (
        config &&
        receivingRepositoryKey(config.internalUrl) === receivingRepositoryKey(input.internalUrl) &&
        config.targetBranch === input.targetBranch
      )
        fail(
          'PROJECT_DESTINATION_IN_USE',
          `项目“${entry.name}”已接管此内部仓库与分支，请选择该项目继续，或配置其他接收仓库 / 分支`,
        );
    }
  }
  async function list() {
    const saved = await registry.read();
    const projects = await Promise.all(
      saved.value.projects.map(async (entry) => {
        try {
          const connection = await get(entry.id),
            receiver = await connection.current(),
            state = await receiver?.status();
          return {
            id: entry.id,
            name: entry.name,
            configured: Boolean(receiver),
            mode: receiver?.config.mode ?? null,
            adopted: Boolean(state),
            activeStatus: state?.active?.status ?? null,
            queued: state?.queue.length ?? 0,
          };
        } catch (error) {
          return { id: entry.id, name: entry.name, error: safeError(error) };
        }
      }),
    );
    return { revision: saved.revision, projects };
  }
  if ((await registry.read()).value.projects.length === 1) await get();
  return {
    transfers: await transferWorkspace(file, options),
    connection: get,
    list,
    current: async () => (await get()).current(),
    create: (input) => registry.create(input),
    rename: (input) => registry.rename(input),
  };
}
