# Tripo Studio

Read existing Tripo Studio share links in an anonymous background page, compare models from multiple angles, and return selected available model files to a directory you choose. This is a standalone plugin package; Clowder owns installation, authorization and process supervision.

Install the reviewed local npm archive through Settings → Plugins → offline install, then enable it. Registry installation becomes available only after an exact package has actually been published and admitted to the machine catalog. Source integration does not imply publication.

The enabled MCP contribution exposes five tools:

- `tripo_review_shared_model`: capture an exact public Studio model URL without using your logged-in Chrome profile.
- `tripo_status`: inspect package, authorization and native-component readiness separately.
- `tripo_prepare_chrome`: prepare the optional local component and browser extension.
- `tripo_collect_authorized_models`: read models already authorized in the browser extension.
- `tripo_export_selected`: verify and copy a previously collected available GLB without overwriting an existing file.

For the optional logged-in path, load the prepared extension in Chrome and explicitly authorize the intended Studio pages. New pages are not automatically authorized. Revoking access stops further reads. The extension, local component and plugin versions must match; preparation and native browser confirmation remain separate from Host enablement.

This version does not submit generation, texturing, purchases or subscription-credit operations. Preview availability is separate from the supplier's formal export: if no model file is exposed, the receipt says `not_exported`. Screenshots do not imply GLB/FBX export, triangle counts or animation support.

Model files, images and provenance stay in the caller's chosen directory. This package contains no user browser profile, cookies, generated models or project-specific paths.

The package runs as native ESM and carries a registry-integrity-pinned `npm-shrinkwrap.json`. The Host materializes those dependencies with its existing script-free dependency admission. Build, pack and tests are owned by this repository; no Core source checkout or bundled-package generator is required.
