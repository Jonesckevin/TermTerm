# Security

Three things are worth protecting in a terminal manager: the credentials of saved connections, the
authenticity of the hosts you connect to, and the boundary between the app's UI and the processes it
runs. Each is handled deliberately.

## The vault

Saved connections (hosts, users, key paths, optional passwords) are encrypted with
**AES-256-GCM** under a key derived by **scrypt** (N = 2¹⁵, r = 8, p = 1, 32-byte key, per-vault
16-byte salt). The master password itself is never stored, never crosses a process boundary, and
never reaches the renderer. The vault file is written `0600` via a temp file + rename so a crash
cannot leave a half-written vault.

- **Locking:** manual (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd>), after 15 minutes of
  inactivity, and on OS suspend – which also wipes the in-memory key and closes every SFTP session.
- **Guessing:** scrypt already makes each attempt expensive; failed unlocks also back off
  exponentially (from the fifth failure, up to 30 s between attempts).
- **Locked state:** connection nodes show a placeholder instead of reconnecting, and the renderer
  only holds connection metadata, never a secret.

## Host keys

SFTP connections verify the server key against `~/.ssh/known_hosts` **before any credential is
offered**. Hashed (`|1|salt|hmac`), `[host]:port`, wildcard, negated and `@revoked` entries are all
understood.

| Situation | Behaviour |
| --- | --- |
| Key matches a known entry | Connect |
| Host unknown | Show `ssh-ed25519 SHA256:…` and require an explicit **Trust this host**; the line is appended to the app's own `known_hosts`, never to yours |
| Key differs from the stored entry | Refuse with "Host key verification failed", name both fingerprints, and offer no way to accept it from the UI |
| Key is `@revoked` | Refuse |

The trust decision is bound to the fingerprint the user actually saw: the main process remembers the
pending key per connection, and `trustHost` rejects a fingerprint mismatch, so a key cannot be
swapped between display and approval.

## The IPC boundary

`contextIsolation: true`, `nodeIntegration: false`, **`sandbox: true`**, no webviews, a narrow
`contextBridge` surface, a CSP that blocks remote script, and `will-navigate` /
`setWindowOpenHandler` / `will-attach-webview` guards. IPC handlers additionally check that the
sender is our own window, so another renderer cannot call them.

**Every argument is validated** (`src/main/validation.ts`), because a renderer that renders
untrusted output is not a trusted caller:

- Node ids, connection ids and host key fingerprints are pattern-checked.
- Hosts, usernames and identity paths reject control characters and anything starting with `-`, so a
  crafted hostname cannot become an extra `ssh` flag.
- Remote paths must be absolute, length-bounded and free of control characters; file names cannot
  contain `/`; the root folder cannot be renamed or deleted; local upload paths must be absolute.
- Nothing is ever run through a shell – every spawn uses an argv array.

## Secrets in transit

- The renderer never receives a stored password: it sends a `connectionId` and the main process
  resolves the secret.
- RDP on Linux receives the password on **stdin** (`/from-stdin`), never argv; on Windows `mstsc.exe`
  prompts itself.
- SFTP keeps the secret inside the main process and only hands it to the SSH library.
- Telnet is cleartext by nature. The UI warns about it; nothing in the app can encrypt it.

## What is stored where

| File | Encrypted | Notes |
| --- | --- | --- |
| `vault.json` | Yes | Connections only |
| `layout.json` | No | Node geometry, layers, links, notes, camera |
| `known_hosts` | n/a | Public host keys you approved |
| `profiles.json` | No | Custom shell commands you wrote |

Because `layout.json` is plain text, connection titles are auto-generated from the *kind*
(`SSH session`) rather than the hostname; only explicit renames are persisted verbatim. SFTP session
data (remote paths, listings) is never written to disk.

## Reporting

This is an alpha. If you find a problem, open an issue with the smallest reproduction you can and
avoid attaching real credentials or production hostnames.
