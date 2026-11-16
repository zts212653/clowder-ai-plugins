import assert from 'node:assert/strict';
import test from 'node:test';
import { searchTargets, targetQuery } from '../src/target-search.mjs';

const items = [
  { id: '123456@chatroom', kind: 'group', displayName: '周末读书群' },
  { id: '654321@chatroom', kind: 'group', displayName: '工作群' },
  { id: 'wxid_abc123', kind: 'direct', displayName: '李明', alias: 'reader-fox' },
  { id: 'wxid_xyz789', kind: 'direct', displayName: 'Tom' },
  { id: '987654@chatroom', kind: 'group', displayName: '987654@chatroom' },
  { id: 'wxid_def456', kind: 'direct', displayName: 'wxid_def456' },
];
const find = query => searchTargets(items, targetQuery({ query })).map(item => item.id);

test('name fuzzy matching does not use identifier namespaces or skipped identifier characters', () => {
  assert.deepEqual(find('tom'), ['wxid_xyz789']);
  for (const query of ['wx', 'id', 'chatroom', '@chatroom', 'wxid_', 'rdf']) assert.deepEqual(find(query), [], query);
  assert.deepEqual(find('周书'), ['123456@chatroom']);
});

test('full identifiers and contiguous identifier fragments still match', () => {
  for (const query of ['123456@chatroom', '2345']) assert.deepEqual(find(query), ['123456@chatroom']);
  for (const query of ['wxid_abc123', 'wxid_abc', 'abc', 'reader-fox', 'der-fo']) assert.deepEqual(find(query), ['wxid_abc123']);
  assert.deepEqual(find('ＴＯＭ'), ['wxid_xyz789']);
});
