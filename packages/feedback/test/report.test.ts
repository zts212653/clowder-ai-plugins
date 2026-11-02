import assert from 'node:assert/strict';
import test from 'node:test';
import {parseReport} from '../src/report.js';

test('readable Issue Markdown remains readable and strips only the final Client signature', () => {
  assert.deepEqual(parseReport('# 界面分析完成\n\n## 问题摘要\n已定位。\n\n[伙伴/model🐾]'), {title:'界面分析完成',body:'## 问题摘要\n已定位。'});
  assert.equal(parseReport('普通聊天内容'),undefined);
  assert.equal(parseReport('{"title":"坏报告"}'),undefined);
});

test('a real Client may prepend commentary before the final Issue heading', () => {
  assert.deepEqual(parseReport('我会依据材料整理报告。\n\n# 反馈模板验收\n\n## 问题摘要\n**事实：**合成样例。\n\n[伙伴/model🐾]'),{title:'反馈模板验收',body:'## 问题摘要\n**事实**：合成样例。'});
});
