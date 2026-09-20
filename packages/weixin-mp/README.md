# WeChat Official Account

`@clowder-ai/weixin-mp` packages the WeChat Official Account publishing limb and its Agent skill. It can
check account connectivity, convert Markdown to WeChat-compatible HTML, upload images and permanent media,
manage drafts, submit publication, inspect publication status, and list or delete provider-owned content.

## What it does

The package exposes a declarative limb at `limbs/weixin-mp.yml`, package-owned invoke handlers, and an Agent
skill that explains the safe publishing journey. The Host owns installation, configuration, secret storage,
grants, invocation leases, and audit records. Draft, article, media, and publication identifiers remain
provider-owned results; the package does not mirror them into Host inventory.

## Configuration

Configure the package through the Clowder AI Manager with a WeChat Official Account App ID and App Secret.
The App Secret is declared as a secret and must be projected only into the verified package runtime. WeChat
account type, verification, API quotas, review policy, and publication eligibility are controlled by WeChat.

## Local content boundary

Local Markdown, HTML, and image reads are restricted to the operating-system temporary directory after
canonical path resolution. Symlink and traversal escapes are rejected. Text reads are capped at 2 MiB and
image reads at 10 MiB. Converted HTML is always written to a new package-selected temporary path.

Remote image downloads accept only public HTTP(S) destinations, pin the resolved address for the request,
reject credentials and private/reserved address space, reject redirects, enforce a 30-second timeout, and
cap the response at 10 MiB.

## Security and failure behavior

- WeChat access tokens are obtained and refreshed by the Host-provided invocation context.
- API token expiry is retried once only after invalidating the cached token.
- Markdown HTML and URL attributes are escaped; unsafe URL schemes are omitted.
- Missing inputs, oversized files, unsafe paths or URLs, unexpected content types, HTTP failures, and
  provider business errors fail closed.
- The package requests only configuration and secret-read capabilities. It has no messaging, wake, thread,
  memory, schedule, or filesystem-wide authority.

This package is an alpha release. Use a non-production Official Account and temporary content during
acceptance before enabling it for real publication.
