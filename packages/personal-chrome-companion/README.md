# Personal Chrome companion (F247)

`@clowder-ai/personal-chrome-companion` is the public, packable source closure
for F247's narrow Chrome MV3 and Native Messaging companion. It exports the
static extension, the POSIX helper CLI, and a
declarative Clowder module plugin (`plugin.yaml`, plugin id
`official.companion.personal-chrome`) that hosts authorized ChatGPT
conversations for the cloud cat.

The Host-loadable builtin runtime is implemented in this package:
`runtime.transport: builtin` with entrypoint `dist/plugin-entrypoint.js`. The
plugin declares `runtime.dataDirectory: personal-chrome-host`, so the Host
provisions `<projectRoot>/.cat-cafe/plugin-host/personal-chrome-host` (0700)
and grants it to the feature through the `data.directory` capability.

## Module plugin surface

The `personal-chrome-host` feature owns one `cloud-conversation-host`
contribution (`provider: chatgpt`). Its three conversation methods use the
package's native-host socket client and the helper's v2 protocol:

- `personal-chrome-host.append-message` sends to an authorized conversation.
- `personal-chrome-host.assistant-returns.list` fetches at most one pending reply.
- `personal-chrome-host.assistant-returns.ack` acknowledges that reply; listing
  alone never removes it.

The `personalChromeAuthorizations` operation lists the authorized
conversations as Host-rendered rows (one `revoke` row action each), revokes one
authorization by `conversationId`, and reports authorization status. The
underlying store holds at most 32 authorizations; the operation surfaces that
ceiling through the status action.

Use **Refresh titles** to ask the connected extension for readable titles of
the currently authorized conversations. The result reports how many titles
were updated, or why refreshing was unavailable; the conversation list then
reloads. Refreshing never grants authorization or clears the extension reload
reminder. Keep Chrome and the paired extension running for this action.

Status also shows the **last observed** helper connection state. It never opens
a socket: use **Test** for a live health probe. Authorization and helper
reachability are reported separately; a connected helper does not by itself
mean the extension is ready or a conversation is authorized.

| Helper state | Meaning and next action |
| --- | --- |
| `unknown` | No connection observation since this start; run Test. |
| `invalid_installation` | Pairing record validation failed; use **Chrome connection** in Settings to repair it, then run Test. Record contents are never shown. This state does not delay list attempts; the next successful connection restores `connected`. |
| `not_installed` | No pairing record; use **Chrome connection** in Settings, then run Test. |
| `unreachable` | Socket missing or connection refused; check Chrome and the extension, then run Test to retry now. Status includes the outage start, failure count and earliest next list attempt. |
| `connected` | A socket connection was accepted; status includes the last contact time. Run Test to check current helper/extension health. |

When the helper is unavailable, list returns `{ returns: [] }` and retries only
on a later Host poll after 2, 4, 8, 16, 32, then at most every 60 seconds. There
is no background retry timer. Append, acknowledge, Test and Refresh titles bypass this delay;
any accepted connection resets it, even when the helper returns a business
failure. Errors after a write are never treated as pre-send unavailability.
Only connection-state changes produce logs. Stop clears these observations and
cancels pending requests; it does not delete authorizations or pending replies.

## Set up Chrome from Settings

Open **Settings → Plugins → Personal Chrome → Chrome connection**. Choose the
setup action and confirm registration of the local helper. The Host verifies
the exact trusted release before invoking its fixed setup runner. Installation
creates the pairing identity privately; you do not copy an extension ID, secret,
or terminal command. Enabling a plugin alone never grants browser registration.

The card gives you the stable extension folder. For the first installation,
open Chrome's Extensions menu → Manage Extensions, enable Developer mode,
and choose **Load unpacked**, selecting that folder. Chrome requires this
browser-side action for an unpacked extension; an ordinary webpage cannot link
to `chrome://extensions`. This release does not claim Chrome Web Store delivery
or unattended extension installation.

Return to the card and run **Test connection**. “Installed” only confirms the
local registration and files. It does not mean Chrome is connected or that a
conversation is authorized. Keep Chrome running; the extension reconnects to
the helper. Test checks the real helper/extension revisions. Then open the exact
ChatGPT conversation you want to authorize and click the extension's toolbar
action. Its authorization will appear in Settings; use the row's revoke action
to remove it, or Refresh titles to retrieve its readable title.

The stable folder is `<projectRoot>/.cat-cafe/plugin-host/personal-chrome-host/extension/`.
On updates or rollbacks the package refreshes these bytes; **Reload** the already
loaded extension in Chrome, then run Test. If the helper has not been installed,
use setup first: reloading Chrome cannot create its registration. The reload
reminder clears only after a correlated reply proves the current revisions.

Setup can be retried without rotating a valid pairing identity. A registration
owned by another installation is a conflict, never silently overwritten. A broken
pairing record is reported honestly; removing and setting up again creates a new
identity. Setup removal refuses while the helper is active: close Chrome before
retrying. It removes only this installation's registration, launcher and pairing,
retaining authorizations, titles, extension files and delivery history. Revoke
individual authorizations explicitly when desired, and remove the extension in
Chrome if you no longer want it loaded.

The fixed protocol and authority boundary for Host integrators are documented in
[native-host/setup-protocol.md](native-host/setup-protocol.md). macOS and Linux
helper installation are supported; Windows setup is explicitly unsupported.
The initial Host product integration targets macOS.

## Helper entrypoint

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

## Authority boundary

Cat Café remains responsible for catalog/SRI/admission, pairing-secret
issuance and rotation, lifecycle supervision, Settings/onboarding, and
user-visible status. The installed helper receives a complete Host-supplied
pairing record or environment configuration; it never generates a secret or
chooses an install path.

The extension may bind only an explicitly clicked exact
`https://chatgpt.com/c/<id>` conversation. Normal dispatch finds that exact
background tab and sends the append request without focusing, navigating,
reloading, activating, selecting, moving, highlighting, reading cookies, or
calling a private ChatGPT API.

## Release status

This package is a review candidate only. It does not publish to npm or the
Chrome Web Store. Signed Chrome Web Store identity/admission and Windows support remain open; Windows is explicitly
unsupported.
