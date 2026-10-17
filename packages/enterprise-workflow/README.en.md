# Enterprise Workflow

[Chinese](README.md) · English

`@clowder-ai/enterprise-workflow` exposes governed WeCom and Lark actions as two
Host-managed direct tools. It does not open an HTTP callback endpoint and it never
receives or stores a callback token. The Host authenticates the calling cat and
rechecks the live plugin instance before `plugin_call` reaches the package action.

## Operator setup

Install and authenticate `wecom-cli` and/or `lark-cli` on the Host machine, then set:

- `wecomCliPath`: executable name or absolute path for `wecom-cli`.
- `larkCliPath`: executable name or absolute path for `lark-cli`.

The paths are ordinary configuration, not secrets. Vendor credentials remain owned
by each local CLI. The plugin requests only `plugin.config.read`.

## Agent journey

1. Confirm `official.enterprise-workflow` is installed, configured, enabled, and running.
2. Call `plugin_list_tools` for that plugin.
3. Select exactly `wecom-actions/wecom_action` or `lark-actions/lark_action` and construct
   arguments from the returned schema.
4. Call `plugin_call`; the returned value is the resource handle for the selected action.

The packaged `skills/enterprise-workflow/SKILL.md` contains branch examples. Do not invoke
the CLI directly: doing so bypasses Host invocation identity, liveness, grants, and audit.

## Package ownership and recovery

The package owns provider argument adaptation, CLI process execution, output parsing, and
resource handles. The Host owns installation, configuration, grants, invocation identity,
audit, enable/disable, and uninstall. Disable or uninstall stops new tool calls; created
vendor resources remain in the vendor tenant and are returned as explicit handles.

## Install permissions

These capabilities come from the single `plugin.yaml`. The Host grants and checks their scope; this document does not grant authority.

| Capability | Purpose |
| --- | --- |
| `plugin.config.read` | Read local CLI paths, not provider account credentials. |

The Host owns installation, grants, credentials and lifecycle; saving configuration preserves enable intent. The language link opens a separate document and does not imply automatic language selection.
