# Read-only file preview providers

A builtin static plugin can declare a `content-preview-provider` with a versioned isolated HTML surface and 1–64 `formats` pairs. Each pair declares a single lower-case alphanumeric extension without its dot and the media type passed to the viewer. The Host matches the last filename extension after lowercasing it. The media type is carried in the snapshot. The viewer validates the bytes.

Each extension may appear only once per manifest, across all preview contributions. When multiple enabled packages match the same extension, the Host rejects the ambiguous request before reading the file. The `docx` extension is reserved for the existing DOCX editor entry point. A single package can declare that editor alongside preview providers for other extensions.

The other fields are `id`, `surface` and `bridgeVersion`. A viewer contribution has no editor operations or materializer.

## Preview bridge 1.0.0

The frame URL carries `cat-cafe-parent-origin` and `cat-cafe-handshake` in its fragment. The nonce matches `^handshake_[A-Za-z0-9_-]{32,128}$`. The renderer installs navigation denial before running viewer code. It sends `{ v: 1, kind: 'cat-cafe-content-preview-ready', bridgeVersion, handshakeNonce }` to the exact parent origin.

The Host accepts ready from the admitted frame window and its exact origin, with the same nonce and declared bridge version. It sends `{ v: 1, kind: 'cat-cafe-content-preview-connect', bridgeVersion, handshakeNonce }` to the exact renderer origin with one transferred MessagePort. The renderer accepts connect only when `event.source === window.parent`, the origin matches exactly, the nonce and bridge version match, and `event.ports.length === 1`. It removes the window message listener after the first valid connect.

The Host transfers one `{ v: 1, kind: 'cat-cafe-content-preview-snapshot', fileName, mediaType, bytes }` message over that port. Each mount opens a fresh authorized snapshot. The Host caps the ArrayBuffer at 50 MiB (52,428,800 source bytes). Treat `fileName` as display text. The Host grants no document owner, editor session or write endpoint.

The port accepts no requests and carries no acknowledgement. The Host can report handshake failure or timeout. After delivery, the iframe reports rendering errors in its own UI.

## Renderer environment

The Host serves package resources from a dedicated origin and enforces a content security policy that blocks external resource loads and outbound connections. Its sandbox disallows popups and form submissions. Renderers must use the Navigation API to deny self-navigation before requests start. Host cookies and Host APIs are outside this origin.

Worker execution is unavailable in the current Host policy. Package the scripts, fonts and other resources required for a main-thread rendering path. Static script, stylesheet and font assets are served from the package origin. Renderers can display images derived locally from the transferred bytes.

A Host that does not support the contribution cannot consume the mixed editor/viewer artifact. Publish the contract candidate first, then ship Host support. Keep the plugin out of the live catalog until a compatible Host is available. The current SDK uses the earlier candidate, so `definePlugin` can declare preview only after the SDK consumes the new contract.
