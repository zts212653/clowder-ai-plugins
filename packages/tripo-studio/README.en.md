# Tripo Studio

[Chinese](README.md)

Read existing Tripo Studio share links in an anonymous background page, compare models from multiple angles, and return selected available model files to a directory you choose. This standalone package owns the business adapter; Clowder owns installation, authorization and process supervision.

Install a reviewed local npm archive through Settings → Plugins, then enable it. Registry installation requires an exact package that has actually been published and admitted to the machine catalog. Source integration does not imply publication.

Use Refresh status under Local component on the plugin card to inspect connectivity. Installing, opening Settings and enabling the plugin do not prepare the native component, start Chrome or grant page access. Disabling the plugin or closing its Settings session cancels outstanding status checks.

The enabled MCP contribution exposes five tools:

- `tripo_review_shared_model`: capture an exact public Studio model URL without using your logged-in Chrome profile.
- `tripo_status`: inspect package, authorization and native-component readiness separately.
- `tripo_prepare_chrome`: prepare the optional local component and browser extension without granting browser permission.
- `tripo_collect_authorized_models`: read models already authorized in the extension, using 1–8 exact model UUIDs per batch.
- `tripo_export_selected`: verify and copy an available GLB collected earlier without overwriting an existing file or selecting a model for the user.

For the optional logged-in path, load the prepared extension in Chrome and explicitly authorize the intended model pages. New pages are not automatically authorized. Revoking access stops further reads. Extension, local-component and plugin versions must match; Host enablement does not prove browser connectivity or permission.

This version does not submit generation, texturing, purchases or subscription-credit operations, enumerate the account directory or read per-item billing. Preview availability is separate from the supplier's formal export: if no model file is exposed, the receipt says `not_exported`. Screenshots do not prove GLB/FBX export, triangle counts or animation support.

Model files, images and provenance stay in the caller's chosen directory. The package contains no user browser profile, cookies, generated models or project-specific paths.

The package runs as native ESM with a registry-integrity-pinned `npm-shrinkwrap.json`. The Host materializes those dependencies through its existing script-free admission. Build, pack and tests belong to this repository; no Core source checkout or bundled-package generator is required.
