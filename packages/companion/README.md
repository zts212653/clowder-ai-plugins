# 猫猫球 (Companion)

`@clowder-ai/companion` is the desktop voice body for a Clowder AI companion: a small
always-on-top desktop window (`renderer/index.html`) through which you talk, think, and
find your shared history together. It ships as a Manager-installable builtin plugin
(`runtime.transport: builtin`) and contributes a single `desktop-window` surface named
`companion`.

## What the plugin declares

- One feature, `companion`, contributing the `companion` desktop window
  (330×350, frameless, transparent, always-on-top, skip-taskbar, bridge version 1.0.0,
  with an integrity-bound entrypoint).
- `manifest.json` is a generated package export and must remain mechanically identical
  to `plugin.yaml`.

## Authority boundary

The Host owns installation, grants, configuration and secrets, window/admission policy,
and lifecycle supervision. The package declares a window surface and ships only
renderer assets; it never mints handles and never reads ambient Host state.

## Exposed capability

This package requests this Host capability, verbatim from its manifest
(`plugin.yaml` — kept in sync by `pnpm test:train-c1-inventory`): `windows.create`.
