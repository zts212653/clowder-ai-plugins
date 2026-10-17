# Companion

[Chinese](README.md) · English

`@clowder-ai/companion` is the desktop voice body for a Clowder AI companion: a small
always-on-top desktop window (`renderer/index.html`) through which you talk, think, and
find your shared history together. It ships as a Manager-installable builtin plugin
(`runtime.transport: builtin`) and contributes a single `desktop-window` surface named
`companion`.

## Authority boundary

The Host owns installation, grants, configuration and secrets, window/admission policy,
and lifecycle supervision. The package declares a window surface and ships only
renderer assets; it never mints handles and never reads ambient Host state.

## Exposed capability

This package requests this Host capability, verbatim from its manifest
(`plugin.yaml` — kept in sync by `pnpm test:train-c1-inventory`): `windows.create`.

## Surface interaction

At rest the desktop shows only your selected cat. Click the cat for voice or text;
right-click for history, screen sharing, household access, sound and hiding.
Dragging moves the cat and folds its controls. Escape folds a panel without
ending the conversation or clearing its draft.

Voice requires an explicit **Voice chat** click. An active microphone badge remains
visible and ends the call in one click. Screen sharing has its own explicit
picker and termination badge. There is no microphone action on a double-click,
page load, body tap or drag.

When a compatible Host advertises receive-only audio, **Listen only** opens the same
conversation with playback but never requests or toggles a microphone. Older
Hosts omit that capability, so the control stays hidden and ordinary voice keeps
the exact legacy connect request. Text remains available independently.

Typing works with voice off. The Host uses the existing owner conversation,
configured duty cat, ordinary message routing and idempotency. The small history
view reads a bounded recent subset; **Full conversation** opens the canonical conversation.
No second transcript database, credentials or selectable Host identity live here.
When the Host supplies a valid per-message identity snapshot, each history row
keeps its real author while separately showing the partner, Live carrier and
deep cat saved with that message. Legacy rows omit this context instead of
borrowing today's selected companion.

## Install permissions

These capabilities come from the single `plugin.yaml`. The Host grants and checks their scope; this document does not grant authority.

| Capability | Purpose |
| --- | --- |
| `windows.create` | Create and use the desktop window authorized by the Host. |

The Host owns installation, grants, credentials and lifecycle; saving configuration preserves enable intent. The language link opens a separate document and does not imply automatic language selection.

## Compatibility and durable input

The desktop surface requires Host bridge 1.6.0; an older Host refuses installation. The Host controls placement, dragging, transparent hit areas, media admission and capture. The plugin receives no raw streams or provider credentials. Hiding releases media; the ordinary Chat entry restores the cat.

Drafts are Host-owned and durable. An unknown send result is read back, never automatically resent. An explicit retry retains the original identity, content and route. A changed canonical conversation invalidates old unconfirmed text rather than replaying it into the new scope. History loading, response phase and body completeness remain separate.

Application assistance is off by default. Settling a prompt opens the ordinary menu without granting screen or call authority. Cat poses use current Host facts; dragging suspends autonomous movement. Reduced motion keeps poses static. Automatic play is bounded by idle and cooldown timers; pounce requires an explicit gesture by default.
