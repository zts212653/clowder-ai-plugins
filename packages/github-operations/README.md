# GitHub Operations

`@clowder-ai/github-operations` owns the schedule and event-facing surface for GitHub review, CI, conflict,
issue, comment, repository scan, and reconciliation work.

## Configuration

The Host projects optional authenticated GitHub tokens and the exact setup-noise login list declared by the
manifest. The package does not read ambient environment or repository configuration.

## Security and authority

Repository tracking registrations, authenticated identity, cursors, leases, deduplication, connector bindings,
delivery, and wake policy remain Host-owned. Provider text and repository metadata cannot mint authority.

## Lifecycle and recovery

All seven schedules use fail-closed no-overlap policies and preserve the Core polling and timeout budgets. The
Host must drain package schedules before restoring preserved Core factories so both paths never run together.

## Exposed capability

This package requests these Host capabilities, verbatim from its manifest
(`plugin.yaml` — kept in sync by `pnpm test:train-c1-inventory`): `schedule.register`, `events.publish`.
