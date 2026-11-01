# Architecture

```
src/
  main/                    Electron main process
    index.ts               Window, validated IPC, vault wiring, lifecycle
    vault.ts               scrypt + AES-256-GCM vault file
    validation.ts          Boundary validation for every IPC argument
    persistence.ts         Atomic layout.json read/write (layers, migrations)
    x11.ts                 X server detection for SSH forwarding
    exec.ts                Process helpers shared by shell/container detection
    containers.ts          Docker/Podman container profiles
    pty/profiles.ts        Shell detection + spawn-spec construction
    sessions/manager.ts    PTY, Telnet socket and RDP launcher sessions
    sessions/telnet.ts     TELNET option negotiation filter
    sessions/connections.ts Saved-connection → process spec
    ssh/knownHosts.ts      known_hosts parsing and host key verification
    ssh/sftp.ts            SFTP sessions, file operations, TOFU approval
  preload/index.ts         contextBridge API (no Node in the renderer)
  renderer/src/
    components/Canvas.tsx        Camera, grid, wheel/pan/zoom input
    components/TerminalNode.tsx  xterm instance, drag/resize, menu
    components/SftpPanel.tsx     Remote file browser
    components/Sidebar.tsx       Layer tree, saved connections
    components/HelpDialog.tsx    In-app help sheet (F1)
    components/LockScreen.tsx    Master-password setup/unlock
    state/useAppStore.ts         zustand store (nodes, layers, camera, statuses)
  shared/types.ts          Types shared by all three layers
```

## Session model

Each node id maps to exactly one session in the main process. Output is batched (~8 ms / 64 KB)
before crossing IPC so a `yes`-like flood cannot saturate the channel, and the main process refuses
to report exits for sessions a restart has already superseded.

Three transports share the interface: a PTY (`node-pty`, which covers local shells, WSL, containers
and SSH), a raw socket (Telnet, with the IAC filter in front), and a launcher (RDP, where the real
window belongs to another process). SFTP is a separate long-lived channel per saved connection.

### Detached session host

Local shells run in `scripts/session-host.cjs`, started detached with `ELECTRON_RUN_AS_NODE` so the
shells outlive a renderer reload. The app never guesses where that host is:

- it asks the OS for a free loopback port and passes it to the host, so two builds – or one stale
  host left by an earlier run – can never be mistaken for each other;
- it waits for the host to answer a `ping` handshake carrying the protocol version, retrying for a
  few seconds instead of a fixed sleep;
- a host that stops answering is discarded and replaced on the next request;
- quitting shuts the host down, so nothing is left listening after the app exits.

If the host cannot be started at all, shells are spawned in-process and the node says so; that keeps
the app usable at the cost of persistence.

## Renderer plumbing

`ptyBus` fans the `pty:data` / `pty:exit` events out to per-node subscribers, so each `TerminalNode`
owns its own xterm instance and cleanup. Nodes are absolute-positioned with CSS variables
(`--cam-x`, `--nx`, `--zoom`) so panning never re-renders React; the settled zoom is mirrored into a
`--fitted` variable that drives both node size and xterm font size.

Node stacking is a separate `stack: string[]` plus `zIndex`. The nodes array is never reordered:
moving a DOM node blurs a focused xterm and swallows the next click.

## Zoom model

The camera is `{x, y, zoom}` and node geometry lives in world units. During a gesture nodes are
scaled with `transform: scale(zoom / fittedZoom)`; 130 ms after the gesture they are re-laid out at
the new scale with `fontSize = round(13 × zoom)` and the PTY is resized to match. The result is
smooth motion and sharp text without a per-frame reflow.

## Where docs live

Long-form documentation is in `docs/`; the app ships an in-app help sheet for the parts you need
mid-session (shortcuts, connection kinds, canvas basics, security summary) so the README can stay
short.
