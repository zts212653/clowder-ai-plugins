---
feature_ids:
  - C-1
topics:
  - plugin-contract
  - npm
  - prerelease
  - release-channel
doc_kind: implementation-plan
created: 2026-07-16
---

# Contract Prerelease Channel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

> **Release decision (2026-07-16):** The first public testing artifact is `0.1.0-beta.1` on `next`; artifact `0.1.0` and `latest` remain reserved until the full plugin-system transformation and acceptance are complete. Merge and publication still require independent approval of the final HEAD.

**Goal:** Publish the testing-stage contract as `@clowder-ai/plugin-contract@0.1.0-beta.1` on npm's `next` channel while reserving `0.1.0` and `latest` for the fully integrated release.

**Architecture:** The package artifact version becomes `0.1.0-beta.1`, but the signed protocol `contractVersion` remains `0.1.0`; release tests enforce that separation. The existing main-push workflow continues to pack once, publish with `--tag next`, and poll the registry until the exact version, integrity, `next` target, and reserved `latest` boundary all match the signed release intent.

**Tech Stack:** npm SemVer prereleases and dist-tags, GitHub Actions, Node.js 20 test runner, pnpm 9.

---

### Task 1: Pin prerelease version and channel as failing release tests

**Files:**
- Modify: `packages/plugin-contract/src/conformance/release-config.test.ts`

**Step 1: Change the package release assertion**

Assert that `contractPackage.version` is exactly `0.1.0-beta.1`, the package is public, and the behavior fixture keeps the signed protocol version `0.1.0` rather than copying the package prerelease suffix.

**Step 2: Pin the non-default npm channel**

Require the publish command to include `--tag next` together with `--provenance --access public`.

**Step 3: Run the focused test to verify RED**

Run: `pnpm --filter @clowder-ai/plugin-contract test -- release-config`

Expected: FAIL because the package is still `0.1.0` and the workflow still publishes to the implicit `latest` tag.

### Task 2: Implement the beta package and `next` publication path

**Files:**
- Modify: `packages/plugin-contract/package.json`
- Modify: `.github/workflows/contract-ci.yml`

**Step 1: Set the artifact version**

Set the package version to `0.1.0-beta.1`. Do not change manifest or behavior-fixture `contractVersion` values; they describe the signed protocol, not the npm artifact channel.

**Step 2: Publish on `next`**

Rename the job step to identify the prerelease and add `--tag next` to the exact-tarball publish command. Keep provenance, public access, validation dependency, exact-version lookup, and integrity verification unchanged.

**Step 3: Run the focused test to verify GREEN**

Run: `pnpm --filter @clowder-ai/plugin-contract test -- release-config`

Expected: PASS.

### Task 3: Make the testing and formal-release boundary explicit

**Files:**
- Modify: `CONTRIBUTING.md`
- Modify: `docs/plans/2026-07-15-contract-v01-publish-activation.md`

**Step 1: Document the channel contract**

State that `0.1.0-beta.1` is installed through `@next`, does not claim `latest`, and exists for C-1/K-1 integration testing.

**Step 2: Preserve the formal release condition**

State that `0.1.0` is published only after the full plugin-system transformation and acceptance are complete. Mark the original direct-`0.1.0` activation plan as superseded for the first registry publication without rewriting its historical tasks.

### Task 4: Verify and hand off the new exact HEAD

**Files:**
- Verify all files above

**Step 1: Run the full local gate**

Run generation freshness, typecheck, lint, all tests, build, conformance, workflow YAML parse, shell-block syntax checks, and `git diff --check`.

Expected: all commands exit 0; 51 tests, 25 contract fixtures, and 16 structurally validated behavior cases remain green.

**Step 2: Inspect the packed artifact**

Run `npm pack --json --ignore-scripts` after the build and require exactly one artifact reporting name `@clowder-ai/plugin-contract`, version `0.1.0-beta.1`, and a non-empty integrity value. Remove the local tarball after inspection.

**Step 3: Commit and push**

Commit the prerelease-channel delta with a Why body and `[砚砚/GPT-5.6 Sol🐾]` signature, then push the feature branch to the PR head.

**Step 4: Update PR truth and re-enter review**

Update PR #3 body/comment to explain `next` versus `latest`, installation syntax, and the reserved formal `0.1.0` boundary. Update PR tracking to the new SHA and request a fresh non-author delta review; do not merge or publish on stale approval.
