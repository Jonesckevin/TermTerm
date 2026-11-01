# Connections

Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> (or **+** in the *Connections* section of the
sidebar) to save a target. Saved connections live in the encrypted vault
([Security](security.md)); clicking one in the sidebar opens it as a node.

| Kind | How it runs |
| --- | --- |
| **SSH** | `ssh -t [-p port] [-i key] [-X/-Y] user@host` in a real PTY. Keys and agent auth; the password prompt happens *inside* the terminal, and an optional password stored in the vault is used by the SFTP browser. |
| **Telnet** | Raw TCP in the main process with a real TELNET filter (IAC negotiation answered, subnegotiations stripped) feeding xterm. Cleartext – the editor warns you. |
| **RDP** | Launches the platform client (`mstsc.exe`, or `xfreerdp` with the password passed on **stdin**, never argv). The session lives in its own window; the node shows its status and a *Reopen* button. |

## X11 forwarding

A per-connection toggle (`-X`, or `-Y` for trusted). TermTerm checks for an X server
(VcXsrv/X410/Xming on Windows, `DISPLAY` elsewhere) and tells you in the editor and in the terminal
when forwarding will not work, so a silent failure becomes a warning.

## SFTP file browser

An SSH node carries a file browser: click the file icon in its header, or right-click the node →
*Browse files*. The terminal stays running underneath, so switching back to it never reconnects.

| Action | How |
| --- | --- |
| Browse | Double-click a folder; ↑ goes to the parent, ⌂ to the login directory |
| Upload | The upload button, or drop files from Explorer/Finder onto the panel |
| Download | Double-click a file, or right-click → *Download…* |
| New folder · rename · delete | Toolbar and right-click menu; deletions ask first, and a folder goes with its contents |
| Refresh | ⟳ re-reads the directory (useful after a `mv` in the terminal) |

Credentials are tried in this order: the connection's identity file, `ssh-agent`
(`SSH_AUTH_SOCK`), the default keys in `~/.ssh`, then the password stored in the vault. The
password field in the connection editor is shared by both: the terminal still lets `ssh` prompt for
itself, while the file browser uses the stored secret directly – and that secret only ever exists
in the main process, because the renderer just names a `connectionId`.

**Host keys are verified, not ignored.** TermTerm reads `~/.ssh/known_hosts` (plain,
`[host]:port`, hashed, wildcard and `@revoked` entries). A key that does not match is refused as a
possible man-in-the-middle attack, with no *trust anyway* shortcut. An unknown host shows its
`SHA256:` fingerprint and needs explicit approval; the accepted line is appended to
`%APPDATA%\TermTerm\known_hosts` beside the vault, so your own `~/.ssh` files are never modified.

Sessions talk SFTP only while a panel is open: switching back to the terminal, locking the vault or
leaving the panel idle for 90 seconds closes the channel.

## Editing and deleting

The sidebar row's pencil opens the editor; the trash can (or *Delete* in the editor) removes the
connection and closes any node using it. RDP passwords are stored in the vault; Telnet passwords are
never stored – the field explains that they are typed into the session.
