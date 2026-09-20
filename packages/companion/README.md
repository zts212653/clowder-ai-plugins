# Companion surface

At rest the desktop shows only your selected cat. Click the cat for voice or text;
right-click for history, screen sharing, household access, sound and hiding.
Dragging moves the cat and folds its controls. Escape folds a panel without
ending the conversation or clearing its draft.

Voice requires an explicit **语音聊** click. An active microphone badge remains
visible and ends the call in one click. Screen sharing has its own explicit
picker and termination badge. There is no microphone action on a double-click,
page load, body tap or drag.

Typing works with voice off. The Host uses the existing owner conversation,
configured duty cat, ordinary message routing and idempotency. The small history
view reads a bounded recent subset; **完整聊天** opens the canonical conversation.
No second transcript database, credentials or selectable Host identity live here.

## Host integration

This surface requires the additive desktop bridge **1.1.0**. The Host computes
placement within the display work area, keeps the cat as its stable anchor, and
owns bounded drag gestures and transparent-area hit testing. Older 1.0-only
Hosts reject this manifest before installation. Media admission and capture
remain in the trusted Host; this package receives neither streams nor provider
SDP. Hiding releases media; the existing Clowder **聊聊** entry restores the cat.

The original animated skin bytes remain unchanged. Public static skin derivatives
and the shared color tokens retain their exact provenance in `source-lock.json`.

## Verification

Run the repository's contract and SDK builds, then `pnpm --filter
@clowder-ai/companion test` and `pnpm --filter @clowder-ai/companion lint`.
`node packages/companion/scripts/preview.mjs` serves the accepted interaction
spike at `/spike/` and the actual built renderer with an explicitly simulated
bridge at `/previous`. The latter covers visual states and text controls; it
does not prove native movement, real capture or model delivery.
