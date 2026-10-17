---
feature_ids: [F202]
topics: [collective, native, references, migration]
doc_kind: implementation
created: 2026-10-13
tips_exempt: "Package-private business reference primitive; no new Host export or public tool."
---

# Collective context reference business boundary

Original ca5 `collective-context-refs.ts` is moved byte for byte in the mechanical
commit. The subsequent edge keeps HMAC-SHA256, invocation/operation/source scope,
base64url output, length rejection, timingSafeEqual and RETURN_REF_INVALID.
Only the key source changes from Host callbackToken to a package-private persistent
key, and the instance ID is added to the tuple. No Host callback credential is read,
stored or exposed, and no Host signing port is introduced.

`openCollectiveContextReferences` takes the existing Host-provisioned private data
directory and a feature-lifetime guard. It stores a fixed native-reference.secret
with mode0600, writes complete temporary bytes with fsync, atomically links without
overwriting another initializer, syncs the directory and reads the winner. Reopen
uses the same key. Invalid existing bytes, non-private/nonregular files and symlinks
refuse instead of regenerating. Only opaqueRef/verifyRef functions leave the closure.

Caller identities must come from authenticated native Host context; tool bodies
cannot choose instance/invocation identity. The helper is private to the package
and absent from its public root exports. Possessing a valid reference is not a
Service permission, participation-currentness proof, purpose-winner proof or Host
Task receipt. Each original consumer must still resolve and recheck its own source
and business authority before effects.

This edge unblocks ordinary public/native reply consumers without waiting for a
new Host signature export. It does not register staged native handlers or weaken
the reconsideration/private Work branches. Those original consumer checks remain
part of the original401/422 migration responsibility. The current installed
Collective module still has its prior entrypoint/manifest and verifyAgent refusal;
no installed/native success is claimed by the helper tests.

The reference tests are included in the existing canonical test:control script.
They exercise real isolated private files, restart,16 concurrent initializers,
separate roots, all tuple dimensions, tampering/length, corrupt state and lifecycle
revocation. This is persistent-key behavior evidence, not authenticated Host use.
