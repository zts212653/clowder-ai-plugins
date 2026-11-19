# Read-only file preview providers

A builtin static plugin can declare a `content-preview-provider` with a versioned isolated HTML surface and one or more `formats` pairs. Each pair names a lower-case file extension without its dot and the media type the browser renderer expects. The Host finds an enabled contribution from these declarations and authorizes the source in the workspace before delivering the file. The viewer validates the bytes with its renderer.

The other fields are `id`, `surface` and `bridgeVersion`. The viewer contribution declares no operations or editor materializer. A package may have a separate DOCX editor contribution with its existing protocol and features.

## Preview bridge 1.0.0

The frame URL carries `cat-cafe-parent-origin` and `cat-cafe-handshake` in its fragment. Before sending ready, the renderer installs the same navigation denial used by static editors. It sends `{ v: 1, kind: 'cat-cafe-content-preview-ready', handshakeNonce }` to the declared parent origin.

The Host verifies the sender, origin and nonce, then sends `{ v: 1, kind: 'cat-cafe-content-preview-connect', handshakeNonce }` to that exact frame origin, transferring a fresh MessagePort. The renderer accepts a connection only from its declared parent and matching nonce. The port receives one snapshot message `{ v: 1, kind: 'cat-cafe-content-preview-snapshot', fileName, mediaType, bytes }`. The bytes are transferred as an ArrayBuffer. The port does not service renderer requests. Each mount opens a fresh authorized snapshot. Preview setup does not create a document owner, issue an editor session or expose a write endpoint.

A Host that does not support the preview contribution cannot consume the new plugin artifact. Publish the contract candidate before Host adoption, and keep the mixed editor/viewer artifact out of the live catalog until a compatible Host is available.
