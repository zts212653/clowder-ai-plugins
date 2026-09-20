# Video Generation

`@clowder-ai/video-generation` gives a Clowder AI Agent MCP tools for submitting and tracking image or
video generation jobs through a configured provider. The package owns the provider protocol templates and
request signing; the Host owns installation, configuration, secret storage, grants, and process lifecycle.

## What it does

The toolset exposes `video_gen_submit` and `video_gen_poll` for asynchronous providers. `submit` accepts a
declared capability plus its template variables and returns a provider task ID. `poll` resumes the same task
until it succeeds, fails, or reaches the provider-specific attempt bound. Supported capabilities vary by
provider and currently include text-to-video, image-to-video, and Jimeng text-to-image.

The package does not generate media locally, download completed media into Host storage, or retain provider
jobs as package inventory. A successful poll returns the provider result URL and best-effort projects a file
rich block when invocation-scoped callback credentials are available.

## Configuration

Configure the package through the Clowder AI Manager.

| Field | Required | Meaning |
| --- | --- | --- |
| `provider` | Yes | `zhipu`, `kling`, or `jimeng`. |
| `authType` | Yes | `apikey`, `jwt-hs256`, or `hmac-sha256-v4`. |
| `apiKey` | Conditional | Required by `apikey`. |
| `accessKey` | Conditional | Required by JWT and HMAC authentication. |
| `secretKey` | Conditional | Required by JWT and HMAC authentication. |
| `baseUrl` | No | HTTPS provider-compatible API origin; defaults to the selected template. |
| `model` | No | Provider model override. |

The manifest keeps credential fields optional because its v0.1 configuration schema cannot express
cross-field conditional requiredness. Runtime startup fails closed when the selected authentication strategy
lacks its required credentials.

## Providers and capabilities

- Zhipu: text-to-video and image-to-video through CogVideoX-compatible asynchronous jobs.
- Kling: text-to-video and image-to-video.
- Jimeng: text-to-video, image-to-video, and text-to-image through Volcengine signing.

Provider model availability, quotas, billing, content policy, and retention are governed by that provider.

## Security and data flow

Prompts, input image URLs, and generation options are sent only to the configured provider. Base URLs must
use HTTPS; loopback HTTP is accepted only for isolated local fixtures, and embedded URL credentials are
rejected. API keys, access keys, secret keys, derived JWTs, HMAC signatures, and signed-query artifacts are
scrubbed from surfaced errors.

The plugin requests only `plugin.config.read` and `secret.read`. It does not request message, thread, memory,
file, schedule, or wake authority.

## Limits and failure behavior

- Provider requests have a 30-second timeout.
- Network failures and HTTP 429/500/502/503/504 responses retry twice.
- Poll intervals and attempt limits are package-owned protocol facts.
- Unknown providers, invalid templates, missing credentials, unsafe base URLs, malformed responses, and
  provider business errors fail closed.
- Poll cancellation stops further provider requests and wait intervals.

This package is an alpha release. Verify provider compatibility and data policy in an isolated environment
before relying on it for sensitive workloads.

## Exposed capability

This package requests these Host capabilities, verbatim from its manifest
(`plugin.yaml` — kept in sync by `pnpm test:train-c1-inventory`): `plugin.config.read`, `secret.read`.
