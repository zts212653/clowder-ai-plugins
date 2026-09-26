# WeChat Visible Reader

`@clowder-ai/wechat-visible-reader` packages a macOS-only limb that reads text currently visible in the
desktop WeChat application. The package owns the native Swift reader, typed result validation, bounded local
authorization state, and privacy-safe outcome metrics. The Host owns installation, invocation leases,
trusted owner-message provenance, grants, and the user-facing authorization surface.

## Capabilities

- `wechat_visible_reader.read_visible_conversation` reads only the currently selected conversation page
  after a local owner arms a short-lived authorization lease.
- `wechat_visible_reader.read_conversation_recent` navigates to one uniquely and exactly matched contact,
  reads 1–30 recent visible messages, and attempts to restore the prior conversation and foreground app.
  Each call requires trusted current-owner-message provenance plus explicit acknowledgement that WeChat will
  be foregrounded and the target conversation may be marked read.

The reader does not send messages, click links, query the WeChat database, scan the full conversation list,
or retain screenshots. Returned text enters the requesting Agent's invocation context and trace.

## Local authorization and privacy

The arm lease is stored in Host plugin state as a scope and expiry only: it carries no operator identity,
expires after 1–30 minutes, is cleared on runtime start/stop, and can be revoked immediately. The package
trusts the Host's local-owner guard for arm/disarm operations, not any identity field in caller input.
At installation, `plugin.state.get` lets the package read that authorization record, and
`plugin.state.set` lets it write or revoke the record. The record contains only the
`visible-conversation` authorization scope and its expiry time—never an operator identity,
message text, or screenshot. An expired or unreadable record cannot authorize a read.
Screenshot bytes exist only inside the native process. Metrics retain success/failure outcomes and typed error counts, never
OCR text, message hashes, screenshots, contacts, or conversation identifiers.

## Runtime boundary

The package compiles its package-owned Swift sources into a source-digest-keyed executable in the operating
system temporary directory. That cache contains code only. Native execution is bounded by time and output
size; malformed, oversized, or semantically inconsistent JSON fails closed. macOS Screen Recording and
Accessibility permissions may be required, and WeChat layout changes can cause a typed refusal.

## Limits and failure behavior

- Visible reads accept at most 200 structured blocks and 20,000 Unicode code points.
- Named reads require a 1–128-code-point contact without control characters and a limit of 1–30.
- OCR/layout uncertainty, ambiguous contacts, header mismatch, restore failure, missing permission, missing
  WeChat, expired authorization, compile failure, timeout, and invalid native output return closed failures.
- The package never treats partial text as complete text.

This package is an alpha release. Acceptance must use a dedicated local WeChat test conversation with no
sensitive production history.
