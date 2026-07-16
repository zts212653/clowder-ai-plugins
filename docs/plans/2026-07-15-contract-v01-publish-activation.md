---
feature_ids:
  - C-1
topics:
  - plugin-contract
  - release-automation
  - npm
doc_kind: implementation-plan
created: 2026-07-15
---

# Contract v0.1 Publish Activation Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

> **2026-07-16 direct operator decision:** This plan records the original direct-to-`0.1.0` activation. After being offered option 1 as `0.1.0-beta.1` on `next`, the operator chose it and reserved the formal release until the full transformation is complete (Cat Café thread `thread_mrkn6povq4zzgh45`, message `0001784184743864-000970-787cf35e`). The first registry publication is therefore governed by `2026-07-16-contract-prerelease-channel.md`: publish `0.1.0-beta.1` on `next`, keep protocol `contractVersion` at `0.1.0`, and reserve artifact `0.1.0` plus `latest` for full-system completion.

**Goal:** Make the first merge to `main` validate and publish `@clowder-ai/plugin-contract@0.1.0` automatically, while preventing pull-request events or failed validation from publishing.

**Architecture:** Keep `contract-ci.yml` as the single release workflow. The `validate` job remains shared by pull requests and `main` pushes; a dependent `publish` job runs only for `push` on `main`, packs one artifact, publishes that exact tarball with the repository `NPM_TOKEN`, and fails closed unless the registry reports the expected version and integrity digest. A repository-level regression test pins the package release state and workflow gates so the bootstrap cannot silently return to a private candidate, publish from a pull request, or accept an unverified registry artifact.

**Tech Stack:** GitHub Actions, pnpm 9, npm registry provenance, Node.js 20 test runner.

---

### Task 1: Pin the v0.1 release gate as a failing test

**Files:**
- Create: `packages/plugin-contract/src/conformance/release-config.test.ts`

**Step 1: Write the failing test**

Read `packages/plugin-contract/package.json` and `.github/workflows/contract-ci.yml` from the repository root. Assert that the package is version `0.1.0` and publishable, and that the workflow contains a `publish` job which depends on `validate`, is gated to `push` on `main`, grants provenance permission, consumes `secrets.NPM_TOKEN`, and runs package publish.

**Step 2: Run the test to verify RED**

Run: `pnpm --filter @clowder-ai/plugin-contract test -- release-config`

Expected: FAIL because the package is `0.1.0-candidate.1`, is private, and the publish job is commented out.

### Task 2: Activate fail-closed v0.1 publishing

**Files:**
- Modify: `packages/plugin-contract/package.json`
- Modify: `.github/workflows/contract-ci.yml`

**Step 1: Make the package publishable**

Set the version to `0.1.0` and set `private` to `false`.

**Step 2: Activate the publish job**

Add a real `publish` job with `needs: validate`, `if: github.event_name == 'push' && github.ref == 'refs/heads/main'`, `contents: read`, `id-token: write`, the same install/build steps as validation, and `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` on the publish step. Pack once, publish that tarball, then poll the exact registry version until its `dist.integrity` matches the packed artifact or the verification window expires.

**Step 3: Run the focused test to verify GREEN**

Run: `pnpm --filter @clowder-ai/plugin-contract test -- release-config`

Expected: PASS.

### Task 3: Verify and hand off the external gate

**Files:**
- Verify all files above

**Step 1: Run the complete contract gate**

Run generation freshness, typecheck, unit tests, build, conformance, and `git diff --check`.

Expected: all commands exit 0; conformance fixtures and behavior cases remain structurally validated; workflow tests prove exact version + integrity verification is active.

**Step 2: Commit and push**

Commit with a Why body, push `feat/pr-1-contract-bootstrap`, and verify PR #3 points at the new SHA.

**Step 3: Preserve the external authority boundary**

Do not merge. Require the maintainer to configure the repository `NPM_TOKEN`, npm scope/package publish permission, and branch rules for dual-sign review before merge.
