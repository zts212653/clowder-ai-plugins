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

This surface requires the additive desktop bridge **1.3.0**. The Host computes
placement within the display work area, keeps the cat as its stable anchor, and
owns bounded drag gestures and transparent-area hit testing. Older 1.0-only
Hosts reject this manifest before installation. Media admission and capture
remain in the trusted Host; this package receives neither streams nor provider
SDP. Hiding releases media; the existing Clowder **聊聊** entry restores the cat.

Xianxian uses one layered sitting body or one VP9 clip at a time. Expiring Host
facts with task, result and event identities select tool work, workspace fetch,
screen reading, applied-result delivery and autonomous target movement.
Dragging instead freezes a visibly held candidate and cancels the old target;
it never renames the running clip. Pounce requires an explicit play gesture by
default; optional automatic play is bounded by idle and cooldown timers.
Reduced motion keeps semantic poses static and suppresses roaming and pounce.
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
