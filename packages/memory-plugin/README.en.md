# Memory plugin

The official Clowder AI memory plugin. It owns memory business rules, storage and background processing; the Host owns identity, authorization, canonical sources and the physical storage roots.

The memory v1 wire contract lives in its own package, `@clowder-ai/plugin-memory-contract`, holding only DTOs, validation and explanation. It versions independently of the F202 `plugin-contract` and the plugin SDK.

[Chinese guide](README.md)

## What this plugin owns

- **Thread KV**: keeps the legacy Redis hash record shape, the 50-key ceiling, oldest-entry eviction only for a new key, and persistent (TTL=0) semantics.
- **Memory business**: retrieval, fusion, degradation, filtering and paging, plus write rules and receipts for matter, person, profile and taste.
- **Background processing**: indexing, rebuilds, the embedding lifecycle and memory task cursors.

The Host keeps the HTTP, MCP and PDL entries, request identity, source authorization and general approvals. The plugin never builds a physical path and never touches a Redis client or SQL handle.

## Protocol

`memory.describe` takes no business parameters and returns `{protocolMajor: 1, operations: string[], storageFormat: 1}`. The Host calls it after loading actions and before declaring the instance healthy, as one admission check; it runs again on every install, package replacement, restart and manual enable.

`memory.dispatch` takes `{operation, input}`. The plugin parses the operation discriminator and its JSON into typed DTOs once at the boundary, so every branch below works with validated input.

The first real consumers are `kv.put`, `kv.get`, `kv.list` and `kv.delete`.

## Host ports

The plugin accepts no unauthorized storage access. The Host supplies `MemoryHostPorts`:

```ts
interface MemoryThreadKvPort {
  readAll(threadRef: string): Promise<Readonly<Record<string, string>>>;
  write(threadRef: string, key: string, json: string): Promise<void>;
  remove(threadRef: string, key: string): Promise<boolean>;
}
```

The Host verifies that `threadRef` names a thread the current call is authorized for, and derives the physical key from it. The plugin passes `threadRef` through verbatim and never assembles a key itself; the deployment `default` family is an ordinary authorized thread reference, not a special case the plugin can route around.

When the Host supplies no such ports, the plugin fails admission instead of degrading to an empty memory library. Degrading would make both sides look healthy while hiding every existing record.

## Development

```bash
pnpm --filter @clowder-ai/plugin-memory-contract build
pnpm --filter @clowder-ai/memory-plugin build
pnpm --filter @clowder-ai/memory-plugin test
```

The console declarations are in `console/pdl.yaml` with text in `console/i18n/`. The Host reads the package console files, not the manifest the plugin's own runtime validates.
