import assert from 'node:assert/strict';
import test from 'node:test';
import {reportPreview} from '../ui/report.js';

test('report preview renders table and inline emphasis without executing model HTML or fetching images', () => {
  const el=(tag:string,attributes={},children:unknown[]=[])=>({tag,attributes,children});
  const tree=reportPreview('## 摘要\n\n**事实**与`错误码`\n\n| 项目 | 状态 |\n|---|---|\n| 回执 | 正常 |\n\n<script>alert(1)</script>\n\n![图](https://example.test/image.png)\n\n[链接](javascript:alert(1))',el);
  const nodes: string[]=[];
  const visit=(node:ReturnType<typeof el>)=>{nodes.push(node.tag);node.children.forEach(child=>visit(child as ReturnType<typeof el>));};
  visit(tree);
  assert.ok(nodes.includes('table') && nodes.includes('strong') && nodes.includes('code'));
  assert.ok(!nodes.includes('script') && !nodes.includes('img') && !nodes.includes('a'));
  assert.ok(JSON.stringify(tree).includes('<script>'));
});
