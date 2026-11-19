# GenOffice DOCX

[Chinese](README.md) · English

`@clowder-ai/genoffice-docx` is the Host-governed DOCX renderer provider for
Clowder AI: it contributes a `content-editor-provider` surface so a compatible
Host can open Word documents (`application/vnd.openxmlformats-officedocument.wordprocessingml.document`)
for collaborative editing — load, settle, comment, and tracked-change
operations — inside a dedicated-origin sandboxed iframe with a semantic
materializer worker. A compatible Host can also open read-only PDF and PPTX previews from the Workspace file tree. Both formats support paging and zoom. PDFs with a text layer also support selection and search. Complex fonts, SmartArt, 3D and some embedded objects may render differently from PowerPoint. The file menu can open the original in the system default application.

## What the plugin declares

- The `edit-docx` feature, contributing the `genoffice-docx` content editor
  provider (`renderer/index.html`, integrity-bound entrypoint,
  `sandbox: dedicated-origin-iframe`, `navigationPolicy: navigation-api-deny`,
  bridge version 1.0.0).
- The `preview-office` feature declares PDF and PPTX on a separate read-only iframe entrypoint.
- `manifest.json` is a generated package export and must remain mechanically
  identical to `plugin.yaml`.

## Authority boundary

The Host owns installation, caller context, configuration and secrets, document
access policy, and lifecycle supervision. The package declares a renderer
surface and ships only renderer/worker assets; it never mints handles, never
reads ambient Host state, and never reaches outside its dedicated origin.

The Host owns installation, caller context, credentials and lifecycle; saving configuration preserves enable intent. The language link opens a separate document and does not imply automatic language selection.
