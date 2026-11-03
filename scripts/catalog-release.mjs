import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { getCatalogPlugin, validatePluginCatalog } from '../packages/plugin-contract/dist/index.js';

const releaseKey = row => `${row.pluginId}@${row.version}`;

function selected(catalog) {
  const validation = validatePluginCatalog(catalog);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  return catalog.plugins.map(plugin => ({ pluginId: plugin.pluginId, ...getCatalogPlugin(catalog, plugin.pluginId) }));
}

function planIndex(candidate, plans) {
  assert.equal(plans?.schemaVersion, 1, 'Invalid release plan schema version');
  assert.ok(Array.isArray(plans.releases), 'Release plans must be a list');
  const index = new Map();
  for (const plan of plans.releases) {
    const key = releaseKey(plan);
    assert.ok(!index.has(key), `${key}: duplicate release plan`);
    const row = candidate.plugins.find(plugin => plugin.pluginId === plan.pluginId)?.versions
      .find(version => version.version === plan.version);
    assert.ok(row && row.artifact.integrity === plan.integrity, `${key}: release plan identity/integrity mismatch`);
    assert.match(plan.owner ?? '', /^[a-z][a-z0-9-]{1,63}$/u, `${key}: name the responsible owner`);
    assert.ok(['activate', 'defer'].includes(plan.disposition), `${key}: invalid release disposition`);
    assert.ok(typeof plan.reviewBy === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(plan.reviewBy)
      && Number.isFinite(Date.parse(plan.reviewBy))
      && new Date(plan.reviewBy).toISOString() === plan.reviewBy.replace('Z', '.000Z'), `${key}: invalid reviewBy date`);
    assert.ok(typeof plan.sourceRef === 'string'
      && /^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/(?:pull|issues)\/\d+(?:#[a-zA-Z0-9_-]+)?$/u.test(plan.sourceRef),
    `${key}: sourceRef must link to the release's public PR or issue`);
    if (plan.disposition === 'defer') {
      for (const field of ['reason', 'condition']) assert.ok(typeof plan[field] === 'string'
        && plan[field].trim().length > 0 && plan[field].length <= 2000, `${key}: deferred release needs ${field}`);
    }
    index.set(key, plan);
  }
  return index;
}

/** A PR declares responsibility; publication and activation remain separate operations. */
export function assertReleasePlans(candidate, live, plans, {
  now = Date.now(), baseCandidate, basePlans = { schemaVersion: 1, releases: [] },
} = {}) {
  const current = selected(candidate), active = selected(live);
  const previous = baseCandidate ? selected(baseCandidate) : [];
  const index = planIndex(candidate, plans);
  for (const release of current) {
    const key = releaseKey(release);
    const activated = isDeepStrictEqual(active.find(row => row.pluginId === release.pluginId), release);
    const changed = baseCandidate !== undefined
      && !isDeepStrictEqual(previous.find(row => row.pluginId === release.pluginId), release);
    const plan = index.get(key);
    if (activated && plan) assert.equal(plan.disposition, 'activate',
      `${key}: a deferred release is still waiting; explicitly release its plan before activation`);
    if (!activated || changed) assert.ok(plan, `${key}: declare an exact release plan before merge`);
    if (plan && (!activated || changed)
      && (changed || !isDeepStrictEqual(basePlans.releases.find(row => releaseKey(row) === key), plan))) {
      assert.ok(Date.parse(plan.reviewBy) > now, `${key}: a new or edited plan needs a future reviewBy date`);
    }
  }
  return current.length;
}

/** Waiting/overdue/unowned are data for the owner, never a failed publication. */
export function releaseStatus(candidate, live, plans, { now = Date.now() } = {}) {
  const current = selected(candidate), active = selected(live), index = planIndex(candidate, plans);
  return current.map(release => {
    const plan = index.get(releaseKey(release));
    const activated = isDeepStrictEqual(active.find(row => row.pluginId === release.pluginId), release);
    const state = activated ? 'active' : !plan ? 'unowned' : Date.parse(plan.reviewBy) <= now ? 'overdue'
      : plan.disposition === 'defer' ? 'deferred' : 'activation-pending';
    return { ...release, state, ...(plan ? { plan } : {}) };
  });
}

export function releaseReport(rows) {
  const lines = ['# Catalog release follow-up', '',
    'Publication and discovery are separate. Waiting is reported to its owner without failing main.', '',
    '| Plugin | Version | State | Published | Owner | Review by |', '| --- | --- | --- | --- | --- | --- |'];
  for (const row of rows) lines.push(`| ${row.pluginId} | ${row.version} | ${row.state} | ${row.published ? 'yes' : 'no'} | ${row.plan?.owner ?? (row.state === 'active' ? '—' : 'release maintainers')} | ${row.plan?.reviewBy ?? (row.state === 'active' ? '—' : 'needs owner')} |`);
  for (const row of rows.filter(row => row.state !== 'active')) {
    lines.push('', `- **${releaseKey(row)}**: ${row.plan?.reason ?? 'Deliver the separately reviewed scoped catalog PR.'}`);
    if (row.plan?.condition) lines.push(`  Release condition: ${row.plan.condition}`);
    if (row.plan) lines.push(`  Source: ${row.plan.sourceRef}`);
  }
  return `${lines.join('\n')}\n`;
}
