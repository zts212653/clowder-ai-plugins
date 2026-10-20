---
feature_ids: [F202]
topics: [personal-chrome, setup, authority]
doc_kind: contract
created: 2026-10-08
---

# Personal Chrome setup protocol v1

This is a **Host-owned setup runner**, not a plugin capability or a public
command executor. Ordinary plugin activation has no HOME registration authority.
The Host must fence the installed version and digest to its trusted official
release, verify integrity, require local owner/session/origin access and explicit
confirmation for mutations, and hold the verified package until the child exits.
No request from the browser supplies a path, command, Node executable or extension
identity. Never run the entrypoint from a same-name, untrusted local package.

Entrypoint: `native-host/setup-host.mjs` in the verified package. Launch with the
Host's `process.execPath`, no shell, and these exact arguments:

`<inspect|install|uninstall> --json --project-root <Host configured project root> --home <Host HOME> --node <Host process.execPath>`

The Host applies its bounded subprocess supervision (30-second deadline, output
limit, cancellation and wait-for-close). Node must resolve to the running Node
executable. Both roots must already exist and be absolute directories. Unknown
or duplicate arguments fail. The CLI outputs exactly one JSON document and no
raw exception/stderr or secret. Every complete protocol response uses exit 0,
including `ok:false` business errors; nonzero exit means a runner crash or failure
to produce the protocol. Inspect is strictly read-only, including when absent.

Success: `{protocolVersion:1, ok:true, action, installed, extensionPath,
extensionId, browserAction, restartRequired}`. `action` echoes the operation.
`installed` attests the helper registration, launcher, private pairing, helper
artifact digest and extension bytes, **not a connected browser**.
`extensionPath` is null when absent, otherwise exactly
`resolve(projectRoot, '.cat-cafe/plugin-host/personal-chrome-host/extension')`.
`extensionId` is SHA-256 of the bundled manifest's DER public `key`, first 16
bytes, with each hex nibble mapped to a-p. The Host independently checks it.

`browserAction` is `load-unpacked` when the persisted delivery record still
requires browser acknowledgment, otherwise `none`. `restartRequired` is the
same pending-browser flag: **load or reload the Chrome extension**, never an
instruction to restart the Host. The UI explains first load vs existing Reload;
it must not claim that installed means connected. Existing Test checks actual
helper/extension/page-adapter revisions and clears the delivery reminder.

Failure: `{protocolVersion:1, ok:false, action, code}`. Codes:
`INVALID_REQUEST`, `UNSUPPORTED_PLATFORM`, `INSTALLATION_BUSY`,
`PERMISSION_DENIED`, `REGISTRATION_CONFLICT`, `HELPER_ACTIVE`,
`INVALID_INSTALLATION`, `DELIVERY_IO`. An unrecognized operation returns a null
action with INVALID_REQUEST. No raw exception text or pairing content is exposed.

Install is an explicit retry/repair of this installation. A valid pairing secret,
socket identity and user state are preserved. Corrupt pairing is never silently
rotated. A foreign registration is never overwritten. Mutation uses existing
installer/delivery leases and activation rollback. It holds the helper's original
socket lease across the whole mutation, so even an earlier helper package cannot
start while setup changes activation files. An owned browser registration is
removed on uninstall even if project-side activation files have been lost.
If extension delivery fails
after helper activation, setup remains incomplete and retryable, not connected.

Uninstall refuses an active helper and foreign registration. It removes only this
installation's Native Messaging manifest, launcher and pairing; it retains all
authorizations, titles, delivery history and extension files. This product action
uses `retainAuthorizations:true`; the pre-existing low-level installer API's
default remains unchanged. Removing/reinstalling is distinct from revoking a
conversation or removing the browser extension.

Browser boundary: an unpacked extension requires explicit owner interaction with
Chrome's Extensions page and directory picker. Setup neither edits browser
preferences nor loads/restarts Chrome or a profile. Sources:
[Chrome loading instructions](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked),
[Native Messaging registration](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).
