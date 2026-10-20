# Tripo Studio

[Chinese](README.md)

Review existing Studio share links and, after a separate browser authorization, prepare a subscription generation task in a plugin-created workspace. This standalone package owns the business adapter. Clowder owns installation, package integrity and process supervision.

This is a **0.2.0 development candidate**. Candidate source and passing tests do not mean this package is loaded, published, or connected to a logged-in subscription. No supplier generation/export or quadruped animation journey has yet been completed with this candidate.

Install a reviewed immutable package through Settings → Plugins. Registry installation requires a real published version and catalog integrity. An existing installed identity must follow the Host's supported update policy: this package does not bypass it, mutate inventory, overwrite installed code or uninstall an instance automatically.

Use Refresh status under Local component on the plugin card to inspect connectivity. Installing, opening Settings and enabling the plugin do not prepare the native component, start Chrome or grant page access. Disabling the plugin or closing its Settings session cancels outstanding status checks.

## Read existing models

The five original tools remain available:

- `tripo_review_shared_model`: collect orbit views from an exact share URL in an anonymous background page.
- `tripo_status`: inspect version, native readiness and separate workspace authorization.
- `tripo_prepare_chrome`: prepare the package-owned extension and native component.
- `tripo_collect_authorized_models`: collect only previously authorized model pages.
- `tripo_export_selected`: copy an already collected available preview GLB. This is not a supplier export.

The **Read only** mode retains that boundary. It cannot upload images or spend credits.

## Subscription workspace candidate

Choose **Generation and export** in the extension and explicitly authorize it. It creates a new Studio workspace with `active:false` in the same Chrome session. It never copies cookies/profiles or activates a user tab. The tab-creation behavior is verified in isolated Chromium; this does not claim continuous macOS foreground monitoring. Revocation closes that plugin-created workspace and prevents subsequent actions. It cannot cancel a task already accepted by the supplier.

- `tripo_workspace_status`: inspect visible parameters/login or open a fixed Generate/Rig/Animate route in the plugin workspace. It does not automatically rig or animate anything.
- `tripo_prepare_generation`: upload the accepted task's one front image or four separate front/left/right/back images, set an explicit privacy value and supported Smart Mesh topology/polycount, and return a digest-bound preview. It does not click Generate. Current submission support requires a verified quantity of one; unsupported UI changes stop the operation.
- `tripo_submit_generation`: submit the exact prepared job once, using the displayed **web subscription credits**. Before the click, both the local task record and extension persist an attempt. A lost response becomes `submission_unknown`; reconnecting, restarting or preparing the same key does not retry it. Verify supplier assets before any new attempt. Automatic retry/reconciliation is deliberately unavailable in this candidate.
- `tripo_generation_status`: read the retained local attempt without retrying or inferring completion.
- `tripo_request_official_export`: invoke a uniquely recognized export menu for a verified selected model and GLB/FBX format. Unknown controls or ambiguous model identity fail closed.
- `tripo_collect_official_export`: poll the tracked download, require model-linked supplier provenance, validate actual bytes, and copy into the chosen directory without overwriting. If the supplier filename/URL cannot be tied to the model, report `download_not_verified`; do not label it exported or regenerate. Real supplier download control compatibility remains unverified.

GLB mesh/skeleton/clip/texture information comes from downloaded bytes. Local accessor bounds are not physical measurements or world dimensions. FBX needs Blender inspection. A website target polycount is never reported as a measured triangle count. The Rig/Animate entry points are visible; quadruped compatibility and idle/walk on an actual model remain to be tested.

No tool calls paid Tripo APIs, purchases/upgrades plans or uploads unrelated references. Generation is a separate action from exporting, collecting, inspecting or copying files. The caller must have an accepted user task and approved images before preparation, and review the real preview before submitting.

## Packaging and validation

The package runs as native ESM with a registry-integrity-pinned `npm-shrinkwrap.json`. A fresh packed consumer installs that lock without scripts and serves all eleven tools. No Core source checkout or bundler is required.

`pnpm --filter @clowder-ai/tripo-studio test` covers package/conformance, native protocol, separate authorization, chunk bounds, single-attempt persistence, changed previews, cancellation, byte checks and fresh-consumer invocation. `node packages/tripo-studio/test/workspace.browser.mjs` uses the repository's existing Companion Playwright toolchain to exercise fixed DOM operations and the actual extension in isolated headless Chromium. Permission responses and supplier DOM are fixtures in that browser check; no real credit-consuming journey is claimed.

Models, images, task records and provenance stay local or in the caller's chosen project directory. This package contains no household images, project paths, browser profiles, cookies or generated models. User task/source references passed to the tools are bounded provenance strings, not credentials or executable instructions.
