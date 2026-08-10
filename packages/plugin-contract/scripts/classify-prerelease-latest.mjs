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

// Preserve the historical NPM_TOKEN release semantics: npm may assign latest
// during a package's first publication even when --tag next is explicit.
// A resumed run treats that exact prerelease as existing registry truth.
process.stdout.write(latest ?? '');
