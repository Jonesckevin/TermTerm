# Verification

Four suites cover the app, and each one runs against the real thing rather than mocks. The Electron
suites launch with their own throwaway `--user-data-dir` under `%TEMP%`, so they never read, clear
or overwrite your own TermTerm layout, vault or `known_hosts`.

| Suite | Checks | Needs | Covers |
| --- | --- | --- | --- |
| `npm run verify` | 26 | – | Canvas, help sheet, PTYs, zoom, drag/resize, restart, close confirmation, layout persistence, stale-host isolation |
| `npm run verify:features` | 56 | Docker for the container checks | Vault, connections, Telnet, layers, notes, layer deletion, containers, locking |
| `npm run verify:profiles` | 38 | – | Shell detection, `ssh_config` parsing, container profiles |
| `npm run verify:sftp` | 38 | An SSH server (see below) | known_hosts, host key approval, SFTP operations |

## What the checks prove

- PowerShell and WSL PTYs actually execute commands typed through the UI (verified by side effects
  on disk)
- WSL nodes start in the Linux home directory
- node drag / resize update world geometry; wheel over a terminal scrolls it instead of panning
- restart returns a node to a running shell with no stale overlay
- a dead listener squatting the port older builds used for the session host does not stop
  terminals from starting
- layout survives a full app restart with identical geometry and live shells
- the vault file is scrypt + AES-256-GCM and contains no plaintext password
- connection names and hosts are absent from both `vault.json` (encrypted) and `layout.json`
- a **real TELNET server** receives keystrokes typed into a Telnet node
- dragging a terminal onto a layer persists, and hiding the layer removes its terminals
- deleting a populated layer asks first: **keep** moves the terminal up (session keeps running),
  **delete everything** removes the whole subtree and closes the session; empty layers delete
  silently
- keeping a parent layer's items promotes its sublayers instead of flattening them
- wrong master password is rejected; the vault relocks on restart and connection nodes show a
  placeholder until unlocked
- X11 availability is reported in the connection editor
- shell detection: MSYS2/Cygwin/Nushell/Preview candidates are present, `ssh_config` user/port/key
  parse correctly, no profile is mislabelled from `System32\bash.exe`, and every offered profile
  produces a valid spawn spec
- a **real running container** appears in the palette and a node opened from it executes a command
  inside that container (verified from the host with `docker exec`), then cleans up
- <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd> creates a note, its text persists, dragging a port
  links it to a terminal, and **send** delivers that text to a live Telnet server
- clicking a terminal that isn't on top still focuses its prompt (nodes stack by z-index, never by
  re-ordering the DOM)
- <kbd>F1</kbd> opens the in-app help sheet and <kbd>Esc</kbd> closes it
- a **real OpenSSH server** drives the SFTP panel: an unknown host key is shown with its `SHA256:`
  fingerprint and refused until approved, folders are created/renamed/deleted, a file uploads and
  downloads byte-identically, a vault-stored password authenticates a second connection, and a
  swapped host key is rejected with no trust option
- the Docker-built Linux tarball unpacks with the compiled `pty.node` and spawns a real PTY under the
  packaged Electron runtime

## The OpenSSH fixture

SFTP checks need a server, so they only run when one is configured. On Windows with WSL:

```powershell
node scripts/sshd-fixture.cjs start   # throwaway sshd in WSL on 127.0.0.1:2222
# export the printed TERMTERM_SSH_* variables
npm run verify:sftp
node scripts/sshd-fixture.cjs stop
```

The fixture creates a `termterm` user with a generated key pair and a password, so both auth paths
are exercised, and it never touches anything outside `/tmp/termterm-sshd` and that user's home.

`npm run verify:sftp:unit` runs only the `known_hosts` checks (no Electron, no server); that is what
CI runs on every push.
