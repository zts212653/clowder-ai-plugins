# Verify the Issue plugin without changing Host

The automated integration test loads the exact package into the **existing Host
implementation**. It changes no Host source, policy, configuration, running café,
or production data. It does not install into your active café.

## Run

Use the repository's pinned artifact toolchain (see `CONTRIBUTING.md`), installed
plugin dependencies, a compiled Clowder AI checkout, `redis-server` on PATH, and
Playwright Chromium. The current harness runs on macOS/Linux with a private Unix
socket. It never builds or restarts Host.

From the plugins repository:

```sh
ISSUE_WORKBENCH_HOST_ROOT=/absolute/path/to/clowder-ai \
  pnpm --filter @clowder-ai/issue-workbench test:host
```

For an installed Chrome, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to its executable.
`ISSUE_WORKBENCH_REDIS_BIN` can select a Redis server executable. To test a package
you already built, set `ISSUE_WORKBENCH_HOST_ARCHIVE` to its absolute `.tgz` path;
otherwise the command builds and packs this plugin. Missing prerequisites fail
the run rather than skipping it.

Output goes to `artifacts/installed-host-<timestamp>/` (override with
`ISSUE_WORKBENCH_HOST_OUTPUT`): the package/hash, complete log,
`host-verification.json`, and `host-browser.png`. The report identifies the Host
checkout, hashes the compiled Host components used, lists fixtures and non-claims,
and checks that Host source status and those runtime bytes remain unchanged.
Detailed test data is retained in the printed isolated temporary directory.

## What is exercised

| Journey | Real components | Explicit test boundary |
| --- | --- | --- |
| Install, configure, enable, disable | Host local archive admission, file inventory, configuration, lifecycle and module carrier | Separate project directories; test grant policy |
| Owner actions | Real HTTP routes, localhost/owner checks, confirmation and activation fences | Injected test owner session; no production cookie/token |
| Cat analysis and feedback | Declared native tools, Host messages, private storage, feedback statistics | Test caller identity and deterministic analysis; no model launched |
| Classification queue | Durable queue and Host-declared schedule action | Test scheduler executes the registered action deterministically |
| Browser usage | Packed HTML/JS/CSS through the existing Host authenticated webhook route; durable edits/history, discussion, owner actions and result refresh | Thin HTTP test listener supplies a fixture owner session; all plugin operations use real Host routes |
| Initial classification and independent assignment | Open/Closed import once; manual classification dispatches before cat results; subsequent results preserve manual edits | Deterministic model results and network-disabled GitHub CLI |
| Owner acceptance | Browser acceptance survives reload and Host recreation; original thread link and start instruction | No synthetic user message or claim that a notification started execution |
| Invitations and explicit acceptance | Bundled `GhTeamProvider`, CLI arguments, protocol parsing, sender/receiver records and receipts | Network-disabled `gh` fixture; separate accounts and Redis databases |
| Recovery and withdrawal | Recreated Host runtime, file inventory, Redis private state, retained inbox, source withdrawal, Manager disable | Thread/message stores retained in memory; not a whole machine restart |

The test launches its **own Redis server with TCP disabled** and append-only
storage under its temporary directory. Each installation has a distinct database.
It stops only its own server. The test `gh` executable rejects unknown operations
and never falls back to your authenticated CLI. No real Issue comment, assignment,
member task or model invocation is made.

The composition's `native()` helper supplies a fixture caller context; it does
not prove that a real model can reach those tools. The package therefore also
declares `issue-team-native` with its bundled `dist/team-mcp.js` entrypoint.
`test/native-mcp.test.mjs` launches that stdio process, checks all nine declared
tools against the manifest and verifies per-call credential rotation and denial.
The artifact test repeats it against the independently installed archive. A full
Host acceptance must additionally observe `/api/plugin-runtime/action` with the
real invocation identity and a persisted analysis result; Manager tool calls alone
do not establish a conversation caller.

## What still needs real acceptance

The default Host policy is tested separately: the canonical archive is admitted,
but `dev.clowder.issue-workbench` receives **zero capabilities**. The functional
lane explicitly supplies the seven declared capabilities to an isolated Host
composition. That fixture is not an installation or authorization mechanism for
the running café. Do not copy it into production or identify this plugin as a
different official plugin to obtain grants.

Real installed acceptance still requires a supported grant path for the existing
workbench connection, followed by a real analysis cat and two GitHub
accounts using a designated test Issue. The receiver must explicitly accept; a
notification is not acceptance. No Host source change is part of this test or
required by the test instructions. `hostInstallable:false` remains the overall
product status until that journey is verified.
