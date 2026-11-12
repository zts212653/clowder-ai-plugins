'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const child = require('node:child_process');
const path = require('node:path');

(async () => {
  if (process.env.GITHUB_REPOSITORY !== 'zts212653/clowder-ai-plugins' ||
      process.env.GITHUB_REF !== 'refs/heads/diag/feedback-oidc-20261112' ||
      process.env.GITHUB_ACTOR !== 'zts212653') throw new Error('Unexpected repository, branch, or actor');
  const tarPath = '.github/feedback-recovery/feedback.tgz';
  const sigPath = '.github/feedback-recovery/provenance.sigstore.json';
  const tar = fs.readFileSync(tarPath);
  const sig = fs.readFileSync(sigPath);
  const hash = (algorithm, bytes, encoding = 'hex') => crypto.createHash(algorithm).update(bytes).digest(encoding);
  if (hash('sha256', tar) !== 'b5eb5108d05b35682e5191b1b158fa07e28b6d882b89677aac470b89c714e2ab' ||
      hash('sha1', tar) !== '5299098685f0e26e7fc3945b96e395fa60a071ac' ||
      hash('sha256', sig) !== '8d5d418e0959c63e8daf9b142727adf06571ff7c7d98a8f742230111d3658b0c') throw new Error('Frozen artifact or signature mismatch');
  const manifest = JSON.parse(child.execFileSync('tar', ['-xOzf', tarPath, 'package/package.json'], { encoding: 'utf8' }));
  if (manifest.name !== '@clowder-ai/feedback' || manifest.version !== '0.1.0-alpha.2') throw new Error('Unexpected package identity');
  const bundle = JSON.parse(sig);
  const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64'));
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  const dependency = statement.predicate?.buildDefinition?.resolvedDependencies?.[0];
  if (workflow?.repository !== 'https://github.com/zts212653/clowder-ai-plugins' ||
      workflow?.path !== '.github/workflows/contract-ci.yml' || workflow?.ref !== 'refs/heads/main' ||
      dependency?.digest?.gitCommit !== '381f734b4593ca39f0e5b2c78b1ea8ec5fc595ac' ||
      statement.predicate?.runDetails?.metadata?.invocationId !== 'https://github.com/zts212653/clowder-ai-plugins/actions/runs/43217100767/attempts/1') throw new Error('Unexpected signed source');
  const globalRoot = child.execFileSync('npm', ['root', '-g'], {encoding: 'utf8'}).trim();
  const npmModules = path.join(globalRoot, 'npm', 'node_modules');
  const npa = require(path.join(npmModules, 'npm-package-arg'));
  const {verifyProvenance} = require(path.join(npmModules, 'libnpmpublish/lib/provenance.js'));
  await verifyProvenance({name: npa.toPurl(npa(`${manifest.name}@${manifest.version}`)), digest: {sha512: hash('sha512', tar)}}, sigPath);
  const token = process.env.NODE_AUTH_TOKEN;
  if (!token) throw new Error('Existing npm credential is missing');
  const read = (url) => fetch(url, {method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000), headers: {authorization: `Bearer ${token}`, accept: 'application/json'}});
  const identity = await read('https://registry.npmjs.org/-/whoami');
  const scope = await read('https://registry.npmjs.org/-/org/clowder-ai/package');
  if (!identity.ok || !scope.ok) throw new Error(`Existing credential preflight failed: identity=${identity.status}, scope=${scope.status}`);
  const scopeBody = await scope.json();
  if (Object.hasOwn(scopeBody, manifest.name)) throw new Error('Package exists in authenticated org view; re-evaluate before publishing');
  const stage = await read('https://registry.npmjs.org/-/stage?package=' + encodeURIComponent(manifest.name));
  if (!stage.ok) throw new Error(`Staging preflight could not establish absence: HTTP ${stage.status}`);
  const staged = await stage.json();
  if (!Array.isArray(staged.items)) throw new Error('Unexpected staging response');
  if (staged.items.some(item => item.packageName === manifest.name && item.version === manifest.version)) throw new Error('Exact version already staged; do not republish');
  const publicPackage = await fetch('https://registry.npmjs.org/' + encodeURIComponent(manifest.name), {method:'GET', redirect:'error', signal: AbortSignal.timeout(15000)});
  if (publicPackage.status !== 404) throw new Error(`Unexpected public package status: ${publicPackage.status}`);
  console.log(JSON.stringify({name: manifest.name, version: manifest.version, sha1: hash('sha1',tar), integrity: 'sha512-' + hash('sha512',tar,'base64'), signedSource:'381f734b4593ca39f0e5b2c78b1ea8ec5fc595ac', published:false, staged:false, credentialsPersisted:false}));
})().catch(error => { console.error('Preflight failed: ' + error.message); process.exitCode = 1; });
