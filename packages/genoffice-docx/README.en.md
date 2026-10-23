# GenOffice DOCX

[Chinese](README.md) · English

`@clowder-ai/genoffice-docx` is the Host-governed DOCX renderer provider for
Clowder AI: it contributes a `content-editor-provider` surface so a compatible
Host can open Word documents (`application/vnd.openxmlformats-officedocument.wordprocessingml.document`)
for collaborative editing — load, settle, comment, and tracked-change
operations — inside a dedicated-origin sandboxed iframe with a semantic
materializer worker.

## What the plugin declares

- One feature, `edit-docx`, contributing the `genoffice-docx` content editor
  provider (`renderer/index.html`, integrity-bound entrypoint,
  `sandbox: dedicated-origin-iframe`, `navigationPolicy: navigation-api-deny`,
  bridge version 1.0.0).
- `manifest.json` is a generated package export and must remain mechanically
  identical to `plugin.yaml`.

## Authority boundary

The Host owns installation, caller context, configuration and secrets, document
access policy, and lifecycle supervision. The package declares a renderer
surface and ships only renderer/worker assets; it never mints handles, never
reads ambient Host state, and never reaches outside its dedicated origin.

The Host owns installation, caller context, credentials and lifecycle; saving configuration preserves enable intent. The language link opens a separate document and does not imply automatic language selection.
