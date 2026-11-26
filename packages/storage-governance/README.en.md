# Storage Governance

[Chinese guide](README.md)

Inspect the disk space used by Clowder AI files by volume, conversation, and category. Enable the plugin, open Storage Governance from the navigation, and start a scan. The inventory supports path search, filters, pagination, and per-file details. Select Worktrees to see registered Git worktree roots and their disk usage. Open a root to inspect its individual files. Registered nested worktrees are counted separately.

## Coverage

Requires a Host with [PR #2065](https://github.com/zts212653/clowder-ai/pull/2065). The Host supplies the current owner's conversation records, attachment references, registered worktrees, work stores, and known Codex, Claude, DeepSeek Harness and temporary data directories. Old archives, independent data stores for other native clients, unregistered exports, and project files without conversation evidence need additional sources. The inventory surfaces inaccessible paths and shared files without a conversation attribution.

Disk usage is the space allocated to a file by the filesystem. A sparse or compressed file can use less disk space than its displayed file size. Hardlinks retain their individual paths and count once on each volume. The scanner skips symlinks, junctions, and cross-device mounts. Missing measurements are shown as unknown. Results are a point-in-time inventory of a live filesystem.

## Local installation

Upload the built archive under Settings → Plugin Integrations, then enable the plugin.
