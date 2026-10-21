---
title: Bounded legacy GitHub source operator
date: 2026-10-21
status: candidate-not-authorized-for-production
---

This is the executable read side of PR #96. It does not install a module, grant
capabilities, stop an old writer, register waits, or migrate a production Task.
The parent recovery owner must obtain approval for the exact connection, owner,
repositories, binary digest, private output and plan digest before a real read.
A matching digest is a configuration fence, not an authorization token.

## Executable and connection

Build the GitHub package, then run its packed
`dist/operational-source-cli.js` with Node >=20. The only backend executable is
the explicitly selected, SHA-256 pinned `redis-cli`. There is no implicit URL,
`.env` loading, credential search, in-process Host context, new service or API.
The existing credential may be supplied through the named
`GITHUB_RECOVERY_*` environment variable; it is passed as `REDISCLI_AUTH`, never
as an argument or output. `ACL WHOAMI` must match the configured username.
Remote TCP requires TLS; plain TCP is restricted to loopback. Port 6399 is
unconditionally rejected. A local Unix socket is also supported. No production
connection was made during preparation.

Create a new owner-only regular JSON file (0600), using the following shape.
Replace the placeholders privately from the approved operator/runtime
configuration; this example is deliberately not a usable production plan.

```json
{
  "v": 1,
  "redisCli": "/opt/homebrew/bin/redis-cli",
  "redisCliSha256": "<actual executable SHA-256>",
  "connection": { "kind": "unix", "socket": "/<approved existing socket>" },
  "database": 0,
  "username": "<existing identity>",
  "passwordEnv": "GITHUB_RECOVERY_EXISTING_PASSWORD",
  "scope": {
    "ownerUserId": "<approved owner ID>",
    "keyPrefix": "cat-cafe:",
    "repositories": ["zts212653/clowder-ai"],
    "excludedTaskIds": ["0001792120368760-000117-3373a9bc"],
    "sourceRef": "thread_mp3ab0r9xqxrkrc5#0001792120311606-000111-c92458ea",
    "oldWriterProofRef": "<independently verified no-writer evidence>"
  }
}
```

Offline planning makes no connection:

```sh
node /<unpacked candidate>/dist/operational-source-cli.js --config /<private>/operator.json --plan
```

Only after the parent/CVO approves the exact read operation:

```sh
node /<unpacked candidate>/dist/operational-source-cli.js --config /<private>/operator.json --execute-plan <approved-planDigest> --output /<private>/new-source.json
```

The output must not exist. It is reserved with `wx`/0600 and contains the frozen
`snapshot`, digest, counts and read-only command tally. Failure can leave an
empty private file; it is not a successful source. Stdout contains counts and
digests, never Task context, server errors, credentials or messages. Config and
source must not be checked into shared evidence. The operator must not point a
fixture command or this candidate at formal storage before approval.

## Legacy layout and exact read surface

The adapter reads the legacy schema at cat-cafe
`a8df6fcb66fbaa6a40f5c49edd0713d4e0d6217a`. It intentionally avoids store
helpers whose nominal reads repair indexes, migrate configurations or persist
dedup TTLs. Read commands are checked before `execFile` invokes the pinned
binary; no shell or caller-provided Redis program exists.

| Family | Keys and fields | Bound |
| --- | --- | --- |
| Tracking membership | `tasks:kind:pr_tracking`, `tasks:kind:issue_tracking`; `ZCARD`, paged `ZRANGE` | 10,000 IDs/kind, 256/page |
| Selected Tasks | `task:<indexed ID>`; identity, kind, subject, user, owner, thread, status, timestamps, title, why, `automationState` via `HMGET` | Complete live + terminal pending rows; 1,000 exported Tasks |
| Original authority | Same selected Task: `HEXISTS` only for `typedWaitRegistration`, `invocationLease`, `claimHistory` | Opaque presence references; bodies stay at source |
| Ownership | `thread:<selected thread>.createdBy` via `HGET` | Must match exact configured owner |
| Repository configuration | `community:repo-configs:index` and selected config hashes; original `connector-binding:github-repo-event:<repo>` route metadata | <=50, canonical names only, route must agree with config |
| Progress | `f141:baseline:<repo>`, `f141:notified:<repo>#pr/issue-N`, `community:repo-comment:cursor:<repo>` via `GET` | Exact approved repositories |
| Comment overlap | `SSCAN community:events:seen MATCH comment:<repo>#*` | <=1,000 IDs/repo, no provider journal bodies |
| Pending tracking receipt | Exact `msg:idem:<owner>:<thread>:github-wait:<Task>:<outcome>`; message routing fields only; exact Queue message-ID index | No History/Queue message bodies or arbitrary `source.meta` |
| Repository delivery continuity | Scoped reconciliation idempotency indexes and `f141:delivery:*` claim strings | Missing notified marker or pending claim remains unresolved |

Connection setup may use AUTH/SELECT; other commands are PING, ACL WHOAMI,
ZCARD, ZRANGE, HMGET, HGET, HEXISTS, GET, SCARD, SMEMBERS, bounded SCAN/SSCAN.
SCAN uses fixed GitHub-family patterns; Redis internally traverses its key
dictionary, but unrelated keys/values are not exported. Each scan is capped at
2,000 pages/20,000 matches, total commands at 50,000, each request at 5 seconds,
and the operation at 5 minutes. Exported JSON is capped at 2 MiB. There are no
KEYS, DUMP, EVAL, HGETALL, snapshots, transactions, persistence or write commands.
The fixture test administrator uses DUMP solely to compare its own isolated
test database before and after; the producer cannot issue it.

These are client-enforced constraints, not a claim that the configured server
ACL is read-only. Use an already available restricted identity if possible;
the tool neither creates users nor changes an ACL. All commands are reads even
if an existing identity has broader permissions.

## Failure and continuity

Two cuts must agree on scoped membership, exported values, pending receipts and
claim digests. A stable pair is not a transactional snapshot over an active
writer: the independently verified absent writer remains a precondition.
Unknown schema, incomplete indexes, unapproved repository, owner or route
drift, excluded Task, plugin-bound/entrusted obligation, unresolved receipt or
oversized source is refused or explicitly retained as unresolved. No guessed
zero, owner rewrite, baseline refresh or rearm is performed. Foreign-owner
Task identity rows are read only to filter the global kind index, not exported.

Unclaimed pending outcomes without an idempotency winner are classified as
not sent using the legacy claim-before-send protocol. A message whose exact
Queue admission index survives is delivered; a visible History row alone is
ambiguous. The later stage planner rejects ambiguity and any unresolved
repository delivery. A committed source retains original generation/frontiers;
expired waits remain history. Existing module stage/commit/native-owner-bind/
recover/release and its rollback boundary are unchanged.

PR #98 independently uses alpha.17 for settings work. This candidate uses the
registry-unpublished alpha.18 coordinate to avoid sharing its candidate version;
it does not merge or modify PR #98. Candidate pins are preparation metadata;
live catalog, initial selection, publication and installation remain excluded.
