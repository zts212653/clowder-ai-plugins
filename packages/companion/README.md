# Companion surface

At rest the desktop shows only your selected cat. Click the cat for voice or text;
right-click for history, screen sharing, household access, sound and hiding.
Dragging moves the cat and folds its controls. Escape folds a panel without
ending the conversation or clearing its draft.

Voice requires an explicit **语音聊** click. An active microphone badge remains
visible and ends the call in one click. Screen sharing has its own explicit
picker and termination badge. There is no microphone action on a double-click,
page load, body tap or drag.

When a compatible Host advertises receive-only audio, **只听** opens the same
conversation with playback but never requests or toggles a microphone. Older
Hosts omit that capability, so the control stays hidden and ordinary voice keeps
the exact legacy connect request. Text remains available independently.

Typing works with voice off. The Host uses the existing owner conversation,
configured duty cat, ordinary message routing and idempotency. The small history
view reads a bounded recent subset; **完整聊天** opens the canonical conversation.
No second transcript database, credentials or selectable Host identity live here.
When the Host supplies a valid per-message identity snapshot, each history row
keeps its real author while separately showing the partner, Live carrier and
deep cat saved with that message. Legacy rows omit this context instead of
borrowing today's selected companion.

## Host integration

This surface requires the additive desktop bridge **1.5.0**. The Host computes
placement within the display work area, keeps the cat as its stable anchor, and
owns bounded drag gestures and transparent-area hit testing. Hosts below 1.5
reject this manifest before installation. Media admission and capture
remain in the trusted Host; this package receives neither streams nor provider
SDP. Hiding releases media; the existing Clowder **聊聊** entry restores the cat.
Bridge 1.4 adds one untrusted first-visible-subtitle observation containing only
an epoch-millisecond time, the current call fence and a Host-correlatable source
reference. It does not claim compositor paint, an unoccluded window or reading.
Message and native-item references use the same bounded, single-line opaque ID
contract as the transcript surfaces that supply them. A Host
`invalid_request` rejects and remembers that candidate for the current call so
another current reference may be observed without retrying the rejected one.
Other failures retry after 1 and 2 seconds, then leave the call's
first-visible result unknown; later text never backfills a manufactured success.
Bridge 1.5 adds Host-bound conversation pages and versioned body continuations.
The renderer can only return opaque cursors issued by the Host; it cannot select
an owner, thread, message, call or byte offset. History progress, response phase
and body completeness remain separate, so a processing draft or truncated body
cannot masquerade as a completed reply.

It also binds the one-line composer to the Host-owned durable draft. Versioned
text submission carries the Host-issued conversation `scopeRef`, draft revision
and caller message identity. An unknown settlement is read back but never
automatically resent; an explicit retry keeps the original text, identity,
revision and route. If the canonical thread changes, the old unconfirmed input
stays visible as invalidated local text and is never replayed into the new scope.
The legacy text and conversation methods remain unchanged for older pairs.

Xianxian uses one layered sitting body or one VP9 clip at a time. Expiring Host
facts with task, result and event identities select tool work, workspace fetch,
screen reading and applied-result delivery. Native travel is independent: the
renderer observes the actual desktop window coordinates, so a running clip can
appear only after the Host window really moves. Dragging suppresses that
observer and freezes a visibly held candidate instead of renaming the running
clip. Pounce requires an explicit play gesture by default; optional automatic
play is bounded by idle and cooldown timers. Reduced motion keeps semantic
poses static; a compatible Host also revokes its native movement lease.
Other cats retain their own skins. The v3 living assets and their hashes are
pinned in `source-lock.json`; the installable renderer carries all 21 assets
itself, including the mid-edge `peek_fade` variant.

The Host keeps a small transparent margin left of the pet hit target so the
pounce's tail is visible without turning empty space into a click target.

## Verification

Run the repository's contract and SDK builds, then `pnpm --filter
@clowder-ai/companion test` and `pnpm --filter @clowder-ai/companion lint`.
`node packages/companion/scripts/preview.mjs` serves the accepted interaction
spike at `/spike/` and the actual built renderer with an explicitly simulated
bridge at `/previous`. The latter covers visual states and text controls; it
does not prove native movement, real capture or model delivery.
