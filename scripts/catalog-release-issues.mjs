import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function gh(args, input) {
  const result = spawnSync('gh', args, { input: input === undefined ? undefined : JSON.stringify(input),
    encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, `Catalog reminder delivery failed: ${result.stderr}`);
  return result.stdout;
}

const marker = row => `<!-- catalog-release:v1:${row.pluginId}@${row.version} -->`;

function reminderBody(row) {
  const plan = row.plan;
  return [marker(row), '', `Release: **${row.pluginId}@${row.version}**`,
    `Responsible owner: **${plan?.owner ?? 'release maintainers — assign an owner'}**`,
    `State: **${row.state}**; published: **${row.published ? 'yes' : 'no'}**.`,
    `Review by: ${plan?.reviewBy ?? 'missing'}.`, '',
    plan?.reason ?? 'A published release needs its separately reviewed catalog activation.',
    ...(plan?.condition ? [`Release condition: ${plan.condition}`] : []),
    ...(plan ? [`Source: ${plan.sourceRef}`] : []), '',
    'Update catalog/release-plans.json when ownership or a waiting condition changes. Use the existing scoped activation command after Host acceptance; never bulk activate an unrelated waiting release.',
    'The daily audit resolves this reminder after activation or replacement. Pending activation does not fail main.',
  ].join('\n');
}

/** JSON stdin/argv only; release text is never interpolated into a shell. */
export function syncReleaseIssues(rows, { repository, runGh = gh } = {}) {
  assert.match(repository ?? '', /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u, 'Set the exact GitHub repository');
  const output = runGh(['api', '--paginate', `repos/${repository}/issues?state=all&per_page=100`, '--jq',
    '.[] | select(.pull_request == null and .user.login == "github-actions[bot]" and ((.body // "") | startswith("<!-- catalog-release:v1:"))) | {number,body,state}']);
  const existing = output.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const wanted = new Set();
  const actions = [];
  for (const row of rows) {
    const key = marker(row);
    if (!(row.state === 'unowned' || row.state === 'overdue'
      || (row.state === 'activation-pending' && row.published))) continue;
    wanted.add(key);
    const issue = existing.find(issue => issue.body.includes(key));
    const body = reminderBody(row);
    const title = `Catalog follow-up: ${row.pluginId}@${row.version} (${row.plan?.owner ?? 'unowned'})`;
    if (!issue) {
      const created = JSON.parse(runGh(['api', '--method', 'POST', `repos/${repository}/issues`, '--input', '-'], { title, body }));
      actions.push({ action: 'created', number: created.number, pluginId: row.pluginId, owner: row.plan?.owner });
    } else if (issue.body !== body || issue.state !== 'open') {
      // Repo Inbox polls comments as well as new issues. Notify before recording
      // the new body so a failed send is retried rather than silently consumed.
      runGh(['api', '--method', 'POST', `repos/${repository}/issues/${issue.number}/comments`, '--input', '-'],
        { body: `Catalog follow-up changed\n\n${body}` });
      runGh(['api', '--method', 'PATCH', `repos/${repository}/issues/${issue.number}`, '--input', '-'], { title, body, state: 'open' });
      actions.push({ action: 'updated', number: issue.number, pluginId: row.pluginId, owner: row.plan?.owner });
    }
  }
  for (const issue of existing.filter(issue => issue.state === 'open')) {
    const key = issue.body.match(/<!-- catalog-release:v1:[^\r\n]+? -->/u)?.[0];
    if (key && !wanted.has(key)) {
      runGh(['api', '--method', 'PATCH', `repos/${repository}/issues/${issue.number}`, '--input', '-'], { state: 'closed' });
      actions.push({ action: 'resolved', number: issue.number });
    }
  }
  return actions;
}
