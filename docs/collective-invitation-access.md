---
title: Private Collective invitation connection details
doc_kind: guide
---

# Private Collective invitation connection details

For a private SSH deployment, an invitation to a friend who already has an SSH key can
include the server coordinates and host-key fingerprint. The Service operator supplies
these **public connection details** through the Service environment. Do not put a private
key, a password, an invitation token, or a session credential in these variables.

```dotenv
COLLECTIVE_INVITE_SSH_HOST=ssh.example.org
COLLECTIVE_INVITE_SSH_PORT=22
COLLECTIVE_INVITE_SSH_FINGERPRINT=SHA256:replace-with-the-verified-43-character-fingerprint
# Optional exact minimum revisions, when the operator has verified them:
# COLLECTIVE_INVITE_CAFE_SOURCE_REVISION=replace-with-40-lowercase-hex-characters
# COLLECTIVE_INVITE_CAFE_PUBLIC_REVISION=replace-with-40-lowercase-hex-characters
```

The example fingerprint is a placeholder and is intentionally invalid. Obtain the actual
fingerprint from the server's public SSH host key and verify it through a trusted channel;
an unverified `ssh-keyscan` result by itself is not proof of server identity. The host is
a hostname or IP address reachable by the intended friends, not a local `localhost` alias.
Each friend still uses their own existing SSH account and key.

The optional revision fields add concrete checks for source and public Café installations.
When supplied, each must be an exact 40-character lowercase Git revision; an invalid value
makes the profile unconfigured. The person preparing the invitation must not guess these
values. Without them, the recipient's cat must verify the required Host capabilities before
continuing and report the running versions if it cannot.

After an authorized Service operator updates its environment, the Service must be restarted
through its normal deployment procedure for the new environment to take effect. This is not
performed by the invitation flow. The existing private listener, firewall, SSH permissions,
data directory and backup procedure are unchanged by setting these three variables.

The authenticated invitation-management endpoint returns the profile only to an active
steward with a bound human identity. The Service reports the loopback address and port of
the connection that actually reached it. If any field is missing or malformed, or the
connection is not loopback, it returns `unconfigured` instead of guessing. Its response is
`no-store`; neither an invitation preview nor an unauthenticated request exposes the profile.

An invitation message embeds those coordinates, the Service instance identity and the
single-use link so that the friend's cat can prepare the connection. A localhost link still
works only on a computer connected to that Service; it does not make the Service public and
does not become reachable on a phone merely because the phone received the message.
