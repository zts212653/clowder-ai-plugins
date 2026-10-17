---
feature_ids: [F202]
topics: [fresh-consumer, immutable-dependencies]
doc_kind: test-fixture-provenance
created: 2026-10-08
---

# Retained SDK beta.12 fixture

This is the canonical MIT-licensed `@clowder-ai/plugin-sdk@0.2.0-beta.12`
archive independently rebuilt from exact source
`80e26fc4bc2c337449c80e3f32184db1a96f07cf` during Batch9 acceptance.
It is an immutable dependency input, not a claim that registry publication has happened.

- Size: 55,750 bytes; 58 archive members.
- SHA-256: `af0cd615aa2b2f8f9de994499f541f83163d9637d56fb89406bc1f7aa023ad7b`
- SRI: `sha512-OWaRO97kFIs5X3RDo+PlIN0C80oLvH7CPp/+55fXOi1NqJxUIB6cuhReQnXU0mvCX0/gDgQjsFLNOPpJHWur1w==`
- Toolchain: Node24.18.0 / npm11.16.0 / pnpm9.15.4, darwin-arm64.
- Historical evidence: `f202-handoff/batch9-sol/final-run/verification.json`
  and `f202-w1-tarballs/clowder-ai-plugin-sdk-0.2.0-beta.12.tgz`.

The fresh consumer test verifies the hash and checks SRI against all retained
production shrinkwraps, then applies a version-specific test-only file resolver.
It proves retained beta.12 and the current SDK can coexist without mutating published package
manifests, rewriting SDK versions or relying on monorepo links. The installed
resolution is checked from each package. It does not claim npm has published
beta.12, nor bypass Host installation or authorization acceptance.

## Retained contract beta.29

The beta.12 SDK still requires contract beta.29. This unchanged canonical archive
comes from the accepted de917e86f39631aa4b70006fa056c7be470942d8 graph
(candidate-de917e8-artifact-matrix.json), and is used as an authenticated retained dependency input.
Size: 228047 bytes. SHA-256: `25225f3c1b3f9935c692dbca7f8f001eca70ab7c198165b4e9ef69ca91d9b458`.
SRI: `sha512-77p2pQyLZvbC+kv7yOOzIdsXNYeUblxy50H6VQVQYx2CB6vwySSux2LvUXzPLvdVZCNuJkFHpY04mZ3vHmnXgQ==`.
The test verifies the retained shrinkwrap and resolves each SDK's contract
independently; beta.30 never masquerades as beta.29.

## Retained SDK beta.15 and contract beta.30

GitHub alpha.15 uses SDK beta.16 and contract beta.32. Other existing plugins
retain their accepted beta.15/beta.30 dependency bytes. These MIT-licensed
canonical archives come from the recorded `c4316f3` alpha.6 artifact graph,
also reused by the independently verified alpha.14 graph at
`d1a6bfb2db8fdf8f0a633ecb5e04ef3ac4a6444a`; they are immutable test inputs,
not evidence of publication. Evidence: `f202-handoff/w3-github/integrated-c4316f3-alpha6/canonical.json`.

- SDK beta.15: 78680 bytes, SHA256 `60912dfbd6911794b84a303c409215524bfe3629c34c41e1564255aa106cd04f`.
- Contract beta.30: 229585 bytes, SHA256 `55379eb6d73d690bef91224e6a0684c7ba8938a88c4b63c41e241e3fd3344dd3`.

The fixture loader checks bytes, versions, SDK dependency and derived SRI
against each retained consumer. It does not allow arbitrary old versions or
replace their bytes with the current workspace packages.

## GitHub retained SDK beta.19 / contract beta.35

GitHub alpha.16 retains its independently accepted 35/19 dependency graph; the
aggregate workspace support source has advanced to36/20. These immutable fixture
bytes come from the frozen neutral candidate `b47b0b773c2b79fc4c45c0b29141de7c02158c17`,
which is an ancestor of W3 `5dd199e`. The original descriptor is
`f202-handoff/w3-github/neutral-beta35-sdk19-r1/artifact-descriptor.json`. Both
original archive SRIs independently match GitHub's unchanged production shrinkwrap.

- SDK beta.19: 89121 bytes, SHA256 `c2c9cda352dd4cdbe2c2754af57b3baca241ed4a3bc4d2fa0a7454d8a9ac2eef`.
- Contract beta.35: 236754 bytes, SHA256 `ca269fb629462d61fce33594de2908aa3c5474d788f9664b0cdb52784002e5f1`.

The version-specific loader verifies original bytes, declared version, SDK-to-contract
edge and derived SRI before the GitHub artifact guard accepts this retained graph.
The guard still rejects an unrecognized identity or changed integrity. These are
immutable inputs, not publication, a rewritten production pin or a current directory
installation proof. Existing beta.12/beta.15 fixtures remain unchanged.

## Protected publication of retained prerequisites

The main-only publisher admits the selected six release prerequisite archives.
The original beta.12/beta.29 pair remains historical; current consumers use the
explicit beta.12.1/beta.29.1 release identities described below. The helper
`prepare-retained-publish-artifact.mjs` authenticates the allowlisted pair, original
hash and SDK-to-contract edge, then copies the archive unchanged. It rejects an
arbitrary path, mismatched package or changed archive; it does not rebuild old
versions from current source. The existing action still checks registry integrity,
uses the `next` tag and verifies publication. Retained prerequisites run before
current versions so they do not leave `next` pointing at an older version.

PR validation performs preparation and registry checks only. Actual publication
requires the existing validated main/maintainer path. No archive here is reported
as published merely because local tests or CI pass.

## Collision-free beta.12.1 / beta.29.1 release identities

On 2026-10-17 npm already held `@clowder-ai/plugin-contract@0.1.0-beta.29`
from upstream commit `b2c3992792a8b36607f5472b653bb442e7f29039`, with integrity
`sha512-D/P67HEfG/KfilU9cVLIcqvqIvc2ZE5OwslPW2OFXivcJupnkogUDf4OxemGYH/tYyAgNINJwg8ZuKd2jB/4Pg==`.
That public archive differs from the historical beta.29 above. Loading the original
SDK beta.12 against it fails because `LIFECYCLE_REJECT_REASONS` is absent.
Historical packed acceptance never authorized overwriting that published identity.

The new archives preserve every original member byte except `package/package.json`:
Contract changes its package version to `0.1.0-beta.29.1`; SDK changes its version to
`0.2.0-beta.12.1` and its contract dependency to `0.1.0-beta.29.1`. No implementation,
types, schema, fixture or export changes. A regression compares every archive member.
The original six archives and their original hashes remain unchanged.

- Contract beta.29.1: 228040 bytes, SHA256 `1c8de1173eb07b89d3c7737cc6f284dd90650cf8dc4418910b3eedb892d61e96`.
- SDK beta.12.1: 55753 bytes, SHA256 `4766cb318410f01c2d60cb9c1ba11daa3ccbfba583f65f7b013d629eb2da3e94`.

Only enterprise-workflow, wechat-visible-reader, weixin-mp and personal-chrome-companion
change their production declarations/shrinkwraps to these explicit identities.
The beta.15/beta.30 and beta.19/beta.35 consumers remain unchanged. The protected
publisher selects the new pair before consuming packages; the registry integrity
check still rejects any published collision. A local archive or green PR is not
proof that either new identity has been published.
