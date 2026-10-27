# Google Cloud Music

[Chinese](README.md)

Ask a cat to generate music and deliver a new MP3 plus provenance into the calling project. Billing belongs to your authorized Google Cloud project, not an AI Studio prepaid balance. This is an unpublished private candidate outside the catalog; the Host must support project-output delivery.

## Setup and use

1. Install the exact package in Plugin Manager and review its project-output delivery description. Installation leaves it disabled.
2. Enter the Google Cloud project that should bear the cost. It needs valid billing, Vertex AI enabled, and sufficient project access for the chosen account.
3. If standard Google Cloud ADC exists on this machine, choose **Reuse this machine's authorized account** and confirm. The plugin verifies its quota project, billing and service state before Manager saves the grant. It does not read browser or AGY private login stores.
4. For a new connection or renewed consent, use your own Google Cloud Desktop app OAuth client. Enter its Client ID and Client Secret in the card, connect, explicitly open the Google link and grant Cloud data access. The background receiver survives the initiating request. Reopening the card resumes the flow; expiry requires an explicit new connection. Cancel stops pending consent; disconnect affects only this plugin.
5. Test the connection, then explicitly enable. Installation, checking, consent and enabling do not generate music.
6. Ask a cat for music and a new relative `.mp3` destination. The cat calls `generate_music` with a stable `requestId` for that intentional generation, keeping the exact arguments when polling or recovering delivery.

An existing valid grant needs no extra login just because the plugin was installed. The selected project and credential are committed together through Manager. A quota-project mismatch is refused rather than silently charging another project. Setup never asks you to copy a token or run a terminal command.

## Costs, failures and recovery

Clip is the default short-music model, estimated at $0.04 per generation; Pro is an explicit choice, estimated at $0.08. Requested duration and BPM are prompt intent, not measured guarantees. Actual charges and Ultra-credit deductions require Cloud billing evidence; receipts keep actual charges unknown.

Before generation the Host checks project authority and reserves both destinations. Existing files and invalid paths are refused first. The plugin retains generated media durably, and the Host accepts it for delivery. Disk or permission failures recover delivery without another generation. Quota, safety and timeout failures stay structured.

`pending` means the same operation is running. `generation_unknown` means the provider result cannot be confirmed: never automatically create a replacement request. `delivery_required` retains the product while delivery needs recovery. Only `delivered` means both files are durable. Recovery keeps the original `requestId` and arguments.

Disabling stops new work and pending authorization receivers. Upgrade, disable and uninstall preserve music, provenance and operation history. Uninstall does not revoke another application's Google login.

## Development verification

Run `pnpm --filter @clowder-ai/music-generation build`, `typecheck`, and `test`. Tests use temporary directories and simulated providers, never real grants or paid generation. Exact packed artifacts still need dependency-closure and complete Host-journey verification; source tests do not establish live acceptance.

Official references: [Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app), [project billing](https://cloud.google.com/billing/docs/reference/rest/v1/projects/getBillingInfo), [service state](https://cloud.google.com/service-usage/docs/reference/rest/v1/services/get), [Vertex AI pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing).
