import { execFileSync } from 'node:child_process';

// Gate (review round 6, B1 class): the sha a CI run is testing must be the
// PR's live head at run time. A push that went to the wrong remote (or any
// head advance after checkout) leaves the PR on an older head while local
// claims are newer; without this check a stale run can be read as "the new
// head is green".
//
// Scope limit, stated honestly: this gate only fires when a run EXISTS. A
// push to the wrong remote produces no PR run at all, so nothing here turns
// red — that class is caught by the human/agent delivery ritual of running
// this script locally before announcing a new HEAD (see CONTRIBUTING), not
// by CI. Also run a fresh `gh run list` against the PR branch when consuming
// CI results.
//
// Usage: node scripts/assert-pr-head.mjs <owner/repo> <pr-number> <tested-sha>

const [repo, prNumber, testedSha] = process.argv.slice(2);
if (!repo || !prNumber || !testedSha) {
  process.stderr.write('usage: assert-pr-head.mjs <owner/repo> <pr-number> <tested-sha>\n');
  process.exit(2);
}

if (!/^[0-9a-f]{40}$/.test(testedSha)) {
  process.stderr.write(`tested sha is not a full oid: ${testedSha}\n`);
  process.exit(1);
}

let liveHead;
try {
  liveHead = execFileSync(
    'gh',
    ['api', `repos/${repo}/pulls/${prNumber}`, '--jq', '.head.sha'],
    { encoding: 'utf8' },
  ).trim();
} catch (error) {
  process.stderr.write(`failed to query PR ${repo}#${prNumber} head: ${error.message}\n`);
  process.exit(1);
}

if (liveHead !== testedSha) {
  process.stderr.write(
    `tested HEAD mismatch: this run tests ${testedSha} but PR ${repo}#${prNumber} head is ${liveHead}\n`
    + 'the push under test never reached the PR (wrong remote?) or the PR moved after checkout\n',
  );
  process.exit(1);
}
process.stdout.write(`pr-head gate: tested sha equals PR ${repo}#${prNumber} head ${liveHead}\n`);
