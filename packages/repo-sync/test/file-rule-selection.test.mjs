import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRules, ruleState, selectableRule, toggleRule } from '../web/file-rule-selection.mjs';

test('file choices preserve rules outside the report and can be individually removed', () => {
  const first = toggleRule(['private/', 'README.md'], 'docs/a.md', true);
  assert.deepEqual(first, ['README.md', 'docs/a.md', 'private/']);
  assert.deepEqual(toggleRule(first, 'README.md', false), ['docs/a.md', 'private/']);
});
test('a directory is an explicit whole-directory rule, collapses child rules and indicates inherited selection', () => {
  const rules = toggleRule(['docs/a.md', 'docs/nested/b.md', 'private/'], 'docs/', true);
  assert.deepEqual(rules, ['docs/', 'private/']);
  assert.deepEqual(ruleState(rules, 'docs/a.md'), { checked: true, inherited: 'docs/', partial: false });
  assert.deepEqual(ruleState(rules, 'docs/'), { checked: true, inherited: null, partial: false });
  assert.deepEqual(toggleRule(rules, 'docs/a.md', false), rules, 'cannot silently narrow a whole directory');
  assert.deepEqual(toggleRule(rules, 'docs/', false), ['private/']);
});
test('partial directories and sibling prefix boundaries are distinguished', () => {
  assert.equal(ruleState(['docs/a.md'], 'docs/').partial, true);
  assert.equal(ruleState(['docs/a.md'], 'docs/').checked, false);
  assert.equal(ruleState(['docs/'], 'docs-old/a.md').checked, false);
  assert.equal(ruleState(['docs/'], 'docs-old/').partial, false);
  assert.deepEqual(parseRules(' README.md\nprivate/\nREADME.md\n'), ['README.md', 'private/']);
});
test('special paths cannot be silently split or normalized by file selection', () => {
  for (const path of ['a\nb.md', ' file.md', 'file.md ', '../file', '.git/config', 'docs/*', 'docs/a:b'])
    assert.equal(selectableRule(path), false, path);
  for (const path of ['文档/操作说明.md', 'docs/a b.md', 'internal-docs/'])
    assert.equal(selectableRule(path), true, path);
});
