# Video Analysis

`@clowder-ai/video-analysis` gives a Clowder AI Agent one read-only MCP tool for
sending one remote HTTPS video URL and a prompt to the configured provider for
analysis. The package owns the provider templates and protocol engine and runs
as a Host-supervised stdio process; installation, configuration, secret storage,
grants, enablement, and lifecycle remain Host decisions.

## What it does

The `video_analysis_execute` tool preserves the pre-migration Host contract. It
accepts `capability` plus a string-valued `vars` object. The provider selects the
capability and required variables:

- Gemini: capability `analyze_url`; vars `videoUrl`, `prompt`, and optional
  `mimeType` (defaults to `video/mp4`).
- Zhipu: capability `analyze`; vars `videoUrl` and `prompt`.

The plugin asks the selected provider to analyze that remote URL and returns the
provider's textual result. It does not download, transcode, index, or retain the
video locally, and it does not grant itself access to Clowder AI messages,
threads, memory, or files.

## Configuration

Configure the plugin through the Clowder AI Manager. Do not place credentials in
a video URL or prompt.

| Field | Required | Meaning |
| --- | --- | --- |
| `provider` | Yes | `gemini` or `zhipu`. |
| `apiKey` | Yes | Provider credential stored and injected by the Host as a secret. |
| `baseUrl` | No | HTTPS provider-compatible API origin. Use only an origin you trust. |
| `model` | No | Provider model override. |

The manifest requests only `plugin.config.read` and `secret.read`. The Host must
grant those capabilities before enabling the MCP contribution.

## Provider defaults

| Provider | Default model | Default API origin | Documentation |
| --- | --- | --- | --- |
| Gemini | `gemini-2.0-flash` | `https://generativelanguage.googleapis.com` | [Gemini API](https://ai.google.dev/gemini-api/docs) |
| Zhipu | `glm-4.6v-flash` | `https://open.bigmodel.cn` | [Zhipu visual models](https://docs.bigmodel.cn/cn/guide/models/vlm) |

A custom model or base URL replaces the corresponding default. Provider model
availability, URL-fetch support, quotas, billing, and data handling are governed
by the selected provider.

## Security and data flow

For each invocation, the plugin sends the prompt and remote video URL to the
configured provider. Gemini receives the API key as its documented `key` query
parameter; Zhipu receives it as a bearer credential. Known raw and encoded forms
of the key are scrubbed from returned errors and results.

Only HTTPS video URLs are accepted, and embedded URL credentials are rejected.
Provider base URLs must use HTTPS; a loopback HTTP origin is accepted only for
isolated local fixtures. The runtime keeps no package-owned history or cache; the
Host owns process supervision and any user-visible records around the tool call.

## Limits and failure behavior

- Each provider request has a 30-second timeout.
- Network failures and HTTP 429/500/502/503/504 responses are retried twice, for
  at most three attempts.
- Provider response bodies are limited to 4 MiB and must be valid UTF-8 JSON.
- Other HTTP failures, malformed provider responses, invalid configuration, and
  invalid URLs fail closed and are returned as MCP tool errors.
- The plugin relies on the provider fetching the remote URL; it does not upload
  a local file or bypass the remote server's access controls.

This package is an alpha release. Verify provider compatibility and data policy
in an isolated environment before relying on it for sensitive workloads.
