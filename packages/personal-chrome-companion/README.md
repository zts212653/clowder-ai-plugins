# Personal Chrome companion (F247)

`@clowder-ai/personal-chrome-companion` is the public, packable source closure
for F247's narrow Chrome MV3 and Native Messaging companion. It exports the
versioned v1 machine grammar, a static extension, and the POSIX helper CLI.

It is **not** a Clowder PluginManifest, a stdio plugin, an Extension Hub, or an
installer.

## Authority boundary

Cat Café remains responsible for catalog/SRI/admission, the Native Messaging
manifest and launcher installation/uninstall, pairing-secret issuance and
rotation, lifecycle supervision, Settings/onboarding, and user-visible status.
The installed helper receives a complete Host-supplied pairing record or
environment configuration; it never generates a secret or chooses an install
path.

The extension may bind only an explicitly clicked exact
`https://chatgpt.com/c/<id>` conversation. Normal dispatch finds that exact
background tab and sends the append request without focusing, navigating,
reloading, activating, selecting, moving, highlighting, reading cookies, or
calling a private ChatGPT API.

## Development-only helper entrypoint

```sh
clowder-personal-chrome-host --help
```

The executable is POSIX-only. It requires either a Cat Café-created
`--pairing-record /absolute/path.json` or all three Host-supplied variables:

```text
CAT_CAFE_PERSONAL_CHROME_SOCKET
CAT_CAFE_PERSONAL_CHROME_LEDGER
CAT_CAFE_PERSONAL_CHROME_PAIRING_SECRET
```

The helper does not install its Native Messaging manifest or launcher. That is
intentionally a Cat Café operation.

## Release status

This package is a review candidate only. It does not publish to npm or the
Chrome Web Store. Signed Chrome Web Store identity/admission, the Cat Café
installer's consumption of this tarball, Settings onboarding, and Windows
support remain open; Windows is explicitly unsupported.
