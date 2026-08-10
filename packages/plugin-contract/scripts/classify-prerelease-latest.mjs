import { readFileSync } from 'node:fs';

const packageVersion = process.env.PACKAGE_VERSION;
if (typeof packageVersion !== 'string' || !packageVersion.includes('-')) {
  throw new Error(`prerelease package version required: ${packageVersion}`);
}

const distTags = JSON.parse(readFileSync(process.env.PACKAGE_TAGS_PATH, 'utf8'));
if (distTags === null || typeof distTags !== 'object' || Array.isArray(distTags)) {
  throw new Error('registry dist-tags must be an object');
}

const latest = distTags.latest;
if (latest !== undefined && (typeof latest !== 'string' || latest.length === 0)) {
  throw new Error(`registry latest tag is not a version: ${latest}`);
}

// npm assigns latest during a package's first publication even when --tag next
// is explicit. On a resumed run, that exact prerelease is incomplete release
// state, not a historical latest target that the workflow may preserve.
process.stdout.write(latest === packageVersion ? '' : (latest ?? ''));
