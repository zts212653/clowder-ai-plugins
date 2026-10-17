import { createHash } from 'node:crypto';
import { fail } from './config.mjs';
import { phase } from './execution.mjs';
import { git } from './process.mjs';

function tagName(name) {
  if (
    typeof name !== 'string' ||
    !/^[\w][\w./-]*$/.test(name) ||
    name.includes('..') ||
    name.includes('//') ||
    name.endsWith('/') ||
    name.endsWith('.lock')
  )
    fail('INVALID_TAG', '标签名称无效');
  return name;
}
export async function listTags(receiver) {
  await receiver.ready();
  const output = await phase('source-tags', '读取上游 tag', () =>
    git(receiver.directory, ['ls-remote', '--tags', receiver.config.sourceUrl], {
      timeout: receiver.config.timeouts?.probe ?? 20000,
    }),
  );
  const refs = new Map(
    output
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(/\s+/).reverse()),
  );
  return [...refs]
    .filter(([ref]) => !ref.endsWith('^{}'))
    .map(([ref, object]) => {
      const name = ref.slice('refs/tags/'.length);
      return { name, object, commit: refs.get(`${ref}^{}`) ?? object };
    })
    .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
}
export async function freezeTag(receiver, name) {
  tagName(name);
  const tag = (await listTags(receiver)).find((entry) => entry.name === name);
  if (!tag) fail('TAG_NOT_FOUND', '来源仓库没有这个标签');
  const ref = `refs/sync/tag-${createHash('sha256').update(name).digest('hex').slice(0, 24)}`;
  await phase('tag-fetch', '下载冻结 tag 对象', () =>
    git(
      receiver.directory,
      ['fetch', '--progress', '--no-tags', receiver.config.sourceUrl, `+refs/tags/${name}:${ref}`],
      { timeout: receiver.config.timeouts?.fetch ?? 600000 },
    ),
  );
  const object = await git(receiver.directory, ['rev-parse', '--verify', ref]);
  const commit = await receiver.sha(ref);
  if (tag.object !== object || tag.commit !== commit) fail('TAG_MOVED', '读取期间标签已变化，请重新选择目标版本');
  await verifyTag(receiver, tag);
  return tag;
}
export async function verifyTag(receiver, frozen) {
  const actual = (await listTags(receiver)).find((tag) => tag.name === frozen.name);
  if (!actual || actual.object !== frozen.object || actual.commit !== frozen.commit)
    fail('TAG_MOVED', '目标标签已移动或删除，冻结交付暂停；不能自动替换目标');
}
