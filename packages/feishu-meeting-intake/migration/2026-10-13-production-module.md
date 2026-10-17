---
feature_ids: [F202]
topics: [plugins, meeting-intake, installation, acceptance]
doc_kind: handoff
created: 2026-10-13
---

# Meeting alpha.11: actual installation journey

This is an original Task1843 source-review candidate. It does not complete C1 or
claim a real Feishu account/Host journey. Host writer owns the existing isolated
Manager/runtime; preserve its 16 installed instances and their data.

## Inputs and entry

Source directory: `/Users/lang/workspace/github-lab/clowder-ai-plugins-train-c1/packages/feishu-meeting-intake`.
The final source-ready receipt will bind exact HEAD/TREE, canonical archive and the
physical dependency graph; install only after independent approval. Host122 found bundled
directory admission unsupported; use the existing Manager local-archive entry with this
exact canonical tgz once the Host large-runner preflight adaptation is approved. This local
artifact includes CLI1.0.85 for macOS arm64 and must match the Host platform.

Host grants are exactly `data.directory`, `plugin.config.read`, `secret.read`,
`thread.readContent`, `messaging.send` (Host d699f241). No metadata-list permission
or specialized meeting-intake/Needs Me backend is needed.

Required real inputs: a Feishu app ID/secret, user authorization with Minutes/VC
read scopes and `docx:document:readonly` for normal note transcripts, an accessible
existing notification thread, and one Minute token/URL that this user can read.
The app/account/target cannot be fabricated by a fixture or inferred by the plugin.
The human supplies meeting interpretation and output goals.

## Exact operation order

1. Select the approved canonical local archive in Manager, install, grant the five capabilities,
   then enable. First enable returns a callable control module, auth
   `not_configured`, collection intent `disabled`, live `stopped`; no CLI/login or
   provider request occurs. An enabled instance is not an authorized collector.
2. Save `appId`, secret `appSecret`, and `notificationThreadId` in Settings. The
   target is checked by the existing Host-filtered `threads.get` port.
3. In authorization, select **Authorize Feishu** (`meeting.connect`), visit the
   returned Feishu URL, then **Check authorization** (`meeting.complete`). Device
   secrets remain private. Each action uses a fresh owner-operation context.
   Authorization alone leaves collection disabled.
4. Save a real `minutesReference`; choose **Import Minutes reference**. One retained
   record and one ordinary thread notification appear. Repeating the import reuses
   the same intent and receipt. **Meeting records** returns rows; only unsettled
   records expose **Retry notification**, bound to their original target and body.
5. From that notification thread ask a participating cat to read the meeting using
   `cat_cafe_meeting_records_list`, then `cat_cafe_meeting_records_read(recordId)`.
   Native identity is supplied by the Host's declared action context. The read
   returns bounded currently authorized source text, generation revision, text
   SHA-256 and read time; it does not label latest text an immutable saved version.
6. **Start collection** explicitly starts polling; **Pause collection** stops it.
   Historical sources require **Preview missed sources**, then an explicit
   future-only or notify-previewed decision bound to the exact preview fingerprint.
7. Disable/re-enable or restart preserves credentials, records, pending receipts
   and requested intent. Live collection returns stopped until explicitly started.
   Stop/revoke cancels owned process groups and refuses late commits.
8. An ambiguous token exchange stays `unknown`; do not repeat it automatically.
   **Verify existing account** reconciles it. Only a confirmed **Reset interrupted
   authorization** abandons the attempt while preserving its private evidence and
   pausing collection. Corrupt credential files are retained and refused.

HTTP Settings operation bodies are plain `{}` or the row action's plain fields;
the existing Host wraps them as `{input: currentValues + body}` for the module.
Do not send another `input` layer. The plugin never accepts body identity fields.

## Evidence boundaries

The controlled module/provider journey covers auth, import, notification, native
read, restart, refusal and unknown recovery. Actual process fixtures prove owned
process-group cleanup and private file-backend custody. The final empty consumer
installs physical dependencies, imports the shipped module, starts the actual MCP,
runs only the packaged CLI version probe and checks stop/revoke.

These prove package behavior and closure. Real Manager installation, Feishu login,
notification/native identity and human/visual acceptance remain the original live
Host journey. Full Collective participation and remaining original native behavior
also remain original C1 work; no withdrawn private-execution design is a dependency.
