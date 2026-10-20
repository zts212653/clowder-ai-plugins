import { createHash } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fail } from './config.mjs';
import { configurationLock, privateLocation, readPrivate, writePrivate } from './private-config.mjs';

export const validProjectId = (id) => id === 'default' || /^[a-f0-9]{24}$/.test(id ?? '');
export async function projectRegistry(file) {
  const root = await privateLocation(file),
    path = `${root}.projects.json`,
    directory = `${root}.projects`;
  async function read() {
    const saved = await readPrivate(path);
    if (saved.config) {
      validateRegistry(saved.config);
      return { value: saved.config, revision: saved.revision };
    }
    try {
      await access(directory);
      fail('PROJECT_REGISTRY_MISSING', '项目目录已有内容但索引丢失，请从备份恢复原索引；不能重建空列表');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const legacy = await readPrivate(root);
    return {
      value: {
        schema: 1,
        projects: [
          {
            id: 'default',
            name: '默认项目',
            configured: Boolean(legacy.config),
            createdAt: null,
          },
        ],
      },
      revision: null,
    };
  }
  async function save(value) {
    validateRegistry(value);
    await writePrivate(path, value);
    await mkdir(directory, { recursive: true });
  }
  async function create(input) {
    if (
      Object.keys(input).some((key) => !['action', 'name', 'expectedRevision', 'requestId'].includes(key)) ||
      !/^[a-f0-9]{32}$/.test(input.requestId ?? '')
    )
      fail('INVALID_PROJECT_INPUT', '新增项目需要名称、索引版本及原请求标识，不能提交目录或命令');
    const name = projectName(input.name);
    return configurationLock(path, async () => {
      const saved = await read(),
        previous = saved.value.projects.find((item) => item.requestId === input.requestId);
      if (previous) return registrationReceipt(previous, name);
      if (input.expectedRevision !== saved.revision)
        fail('PROJECT_LIST_CHANGED', '项目列表已变化，请刷新后新增，原项目未覆盖');
      if (saved.value.projects.some((item) => item.name === name))
        fail('PROJECT_NAME_EXISTS', '已有同名项目，请选用不同名称');
      if (saved.value.projects.length >= 100) fail('PROJECT_LIMIT', '单个工作台最多 100 个项目');
      const id = createHash('sha256').update(`${root}:${input.requestId}`).digest('hex').slice(0, 24);
      const project = {
        id,
        name,
        originalName: name,
        requestId: input.requestId,
        configured: false,
        createdAt: new Date().toISOString(),
      };
      saved.value.projects.push(project);
      await save(saved.value);
      return { id, name };
    });
  }
  async function rename(input) {
    if (Object.keys(input).some((key) => !['action', 'id', 'name', 'expectedRevision'].includes(key)))
      fail('INVALID_PROJECT_INPUT', '项目命名参数无效');
    const name = projectName(input.name);
    return configurationLock(path, async () => {
      const saved = await read();
      if (input.expectedRevision !== saved.revision) fail('PROJECT_LIST_CHANGED', '项目列表已变化，请刷新后命名');
      const project = saved.value.projects.find((item) => item.id === input.id);
      if (!project) fail('PROJECT_NOT_FOUND', '项目不存在，未操作其他项目');
      if (saved.value.projects.some((item) => item.id !== project.id && item.name === name))
        fail('PROJECT_NAME_EXISTS', '已有同名项目');
      project.name = name;
      await save(saved.value);
      return { id: project.id, name };
    });
  }
  await read();
  return {
    root,
    path,
    read,
    save,
    create,
    rename,
    configuration: (id) => (id === 'default' ? root : join(directory, id, 'config.json')),
    locked: (operation) => configurationLock(path, operation),
  };
}
function projectName(value) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > 80 ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    fail('INVALID_PROJECT_NAME', '项目名称需要 1～80 个字符，不含控制字符');
  return value.trim();
}
function validateRegistry(value) {
  if (
    value.schema !== 1 ||
    Object.keys(value).some((key) => !['schema', 'projects'].includes(key)) ||
    !Array.isArray(value.projects) ||
    !value.projects.length ||
    value.projects.length > 100 ||
    value.projects.filter((item) => item?.id === 'default').length !== 1
  )
    fail('PROJECT_REGISTRY_INVALID', '项目索引损坏或版本不支持，保留原文件；不能重建空列表');
  const ids = new Set(),
    names = new Set(),
    requests = new Set();
  for (const item of value.projects) {
    if (
      !item ||
      !validProjectId(item.id) ||
      ids.has(item.id) ||
      typeof item.configured !== 'boolean' ||
      Object.keys(item).some(
        (key) => !['id', 'name', 'configured', 'createdAt', 'requestId', 'originalName'].includes(key),
      ) ||
      projectName(item.name) !== item.name ||
      names.has(item.name)
    )
      fail('PROJECT_REGISTRY_INVALID', '项目身份、名称或配置标识损坏');
    if (
      item.id !== 'default' &&
      (!/^[a-f0-9]{32}$/.test(item.requestId ?? '') ||
        requests.has(item.requestId) ||
        !Number.isFinite(Date.parse(item.createdAt)) ||
        projectName(item.originalName) !== item.originalName)
    )
      fail('PROJECT_REGISTRY_INVALID', '项目注册请求或时间损坏，不能重新登记');
    ids.add(item.id);
    names.add(item.name);
    requests.add(item.requestId);
  }
}

function registrationReceipt(previous, name) {
  if (previous.originalName !== name) fail('PROJECT_REQUEST_CHANGED', '同一新增请求不能改成另一个项目');
  return { id: previous.id, name: previous.name };
}
