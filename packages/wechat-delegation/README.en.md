# WeChat delegation (development candidate)

[Simplified Chinese](README.md) · English

An installable Clowder AI plugin for proactive conversations with explicitly selected WeChat friends or groups. Choose a real cat, define the persona and purpose, enable delegation, and take over at any time. Ordinary messages within the approved scope do not require individual approval.

This candidate uses the third-party Agent WeChat native HTTP API. It does not substitute iLink bot conversations or desktop OCR for personal friend and group messaging. It remains a private development package to prevent premature npm/catalog publication. Verified local archives can still be installed; public distribution requires the repository's release process.

## Setup and use

1. Install the archive into a compatible Host and enable it. Close the introduction and click the WeChat delegation speech-bubble icon near the bottom of the far-left navigation rail. The introduction contains documentation and lifecycle management; account connection, authorization and takeover live in the panel. Enabling the plugin does not start the native client or authorize conversations.
2. Read and accept the third-party component and synchronization disclosure. Prepare the account component through the panel. The plugin downloads a pinned release, checks its SHA-256 and supervises a dedicated process. There are no token-copying or terminal setup steps.
3. Scan the actual login QR with your phone and confirm the account. Saved login trust may reconnect and synchronize when the component starts. Login alone grants cats no conversation access.
4. Select a real friend or group, an available cat, a persona and purpose. Review the actual model service and explicitly authorize automatic replies and/or proactive messages.
5. Start an immediate conversation or opt into a recurring policy with a timezone, permitted hours, interval, daily limit and turn budget. Proactive follow-ups stop while the peer has not answered. Group permission never extends to members' direct messages.
6. Use the conversation takeover button or the persistent global pause button. Local future sending stops first; already handed-off sends remain visible until cancellation or their result is known. Only an explicit owner action resumes delegation.

If you select a Clowder notification thread, an exact owner-authored `/takeover` command stops its bound conversations, and `/pause-all` stops all delegation. The plugin reads canonical human sender facts; external contacts and display names cannot become the owner. This command path requires trusted sender facts from the Host. Panel takeover remains available.

Not seeing a message is not proof that it was never sent. Unknown results are inspected under the original send key and are never automatically resubmitted. The owner may separately record that they checked the exact conversation and complete text and observed the message being sent.

## Boundaries and persistence

- Requires a Host with builtin modules, owner HTTP panels, storage CAS and controlled member sessions. Missing controlled execution is reported as unavailable; there is no fallback to an unrestricted household cat.
- Controlled sessions use no household memory and an MCP server exposing no tools, resources or prompts. Model output is structured text; it cannot grant permissions, change recipients or execute payments, files, commands, attachments or links.
- The pinned native component is Agent WeChat v2.4.1, licensed under MIT, with registered macOS ARM64 and Linux ARM64/x64 artifacts. Source URLs and exact release digests are in `src/native-supervisor.mjs`; it never follows `latest`.
- The native client starts only after an owner preparation action. Its profile and startup configuration live in the Host's dedicated `dataPath/native-profile` and `dataPath/native-config` directories. It inherits no household HOME and does not import the official desktop application's profile. The local API credential travels over a private stdin pipe, not through model context, chat, URLs, process arguments or logs.
- The underlying client may synchronize data beyond selected conversations. The plugin sends text to a model and posts messages only within explicitly approved account and stable conversation bindings.
- The HTTP adapter only accesses its owned loopback daemon, refuses redirects and oversized responses, and verifies server/account identity before sending.
- Conversation settings, policies and audit records persist without automatic deletion. An optional execution expiry limits future behavior while retaining configuration and history. Restart, disable and configuration changes pause delegation and preserve unknown outcomes. New grants do not revive old permits or late drafts.

Explicit financial, credential, account-security or owner-contact requests pause delegation. Text rules and models are not proof of complete scam detection. This version sends text only. Choose a Clowder thread for owner handoff notifications; historical audit records remain available through bounded pages.

## Verification

```sh
node --test test/*.test.mjs
npm run build
```

Transport tests use a real loopback HTTP fixture. Process supervision tests execute a synthetic isolated program, not the vendor binary. Other checks cover takeover races, canonical owner control, group isolation, restart, durable acknowledgements and recovery without duplicate sends. The packed artifact is installed into an empty offline consumer and its real panel is served without starting the native client.

The browser journey uses the real panel with an explicitly labeled isolated fake platform/model. It does not connect an account or send messages to WeChat. Vendor binary execution, owner login, real friend/group receipt and takeover acceptance require separate evidence and are not claimed by simulation tests.

Protocol source reviewed: `thisnick/agent-wechat@1e7dec817ca2ff893b8365b768058b6c0274563d`, including the shared HTTP client/generated contracts, core account status, and managed-host implementation. Release metadata was read on 2026-11-14. The project publishes both its code and artifacts; neither is independent proof of account safety or official platform endorsement.
