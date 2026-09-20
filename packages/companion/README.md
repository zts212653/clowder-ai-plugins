# Companion surface

The installed Host owns identity, history, permissions and capture. This package
renders the selected cat and sends explicit user actions through the existing bridge.

## Compact surface candidate

Opening the body leaves voice off. The default surface is a transparent cat with
a small **聊聊** button. That button retains the synchronous, single-click prepare
and audio intent. During a conversation the compact strip exposes microphone,
speaker and stop controls; screen sharing remains an explicit separate choice.

**文字与更多** expands the existing local transcript, text input, canonical chat
navigation and household access preference. Closing this panel does not end a
conversation. Ending voice returns to the small start control; failures remain
visible. No user preference, identity or durable history is migrated by this UI.

The old ragdoll/yarn PNG was itself a cropped scene with opaque edges. Its
replacement preserves the reference character on a complete transparent still.
The animated skins retain their existing asset bytes and mappings. The source
lock distinguishes original public references from generated derivatives.

## Local visual inspection

From the repository root:

```sh
pnpm --filter @clowder-ai/plugin-contract build
pnpm --filter @clowder-ai/plugin-sdk build
pnpm --filter @clowder-ai/companion test
node packages/companion/scripts/preview.mjs
```

Open `http://127.0.0.1:3891/`. The page loads the actual built renderer with an
explicitly labelled local fixture bridge. Check all four skins, light/dark
backgrounds, idle/connecting/talking, panel expansion and connection failure.
The preview cannot connect to a Host or capture audio/screen media. It is not
proof of installed Electron integration or a successful real conversation.

The candidate has not changed a published version or catalog integrity. Design
confirmation, independent review, release evidence and the consuming Host's
installed-window check remain required before presenting it as delivered.
