# UX roadmap

## Product direction

Keep TermTerm fast for terminal power users while making the canvas understandable to someone who has never used a spatial terminal. The next priority is reducing launch friction, making session state unambiguous, and preventing accidental loss of work.

## How this plan is ordered

`Foundations` are prerequisites: every later item assumes them. Each wave is small enough to finish in one release and carries one exit criterion. Definition of done is the same everywhere:

- a behaviour check in the relevant `scripts/verify-*.cjs` suite;
- the matching `docs/` page and the in-app help sheet (`HelpDialog.tsx`) updated in the same change;
- no new IPC without a sender check and argument validation in `src/main/validation.ts`.

## Foundations (unblocks the rest)

1. **One lifecycle path per node**
   - Every close entry point (header, node menu, sidebar, `Ctrl+Shift+W`, layer purge) goes through one confirmation and one cleanup routine.
   - Layer purge must kill the sessions it removes instead of orphaning them.
   - IPC surfaces are registered at startup, never lazily from inside another handler (the scrollback export regression came from exactly that).
   - Done when: no close path can leave a PTY behind and the shared dialog is covered by `verify-e2e`.

2. **Settings store and Settings dialog**
   - Persist `settings.json` in `userData`, sanitised the same way as `layout.json`.
   - First fields: font family and size, scrollback length, restore policy (attach / ask / respawn), copy-on-select, right-click paste, reduced motion, confirmation policy.
   - Done when: preferences survive a restart and apply without reloading the layout.

3. **Command registry**
   - One definition per command: `{ id, label, shortcut, enabled, run }`.
   - Render it as the command palette, application menu, node and sidebar context menus, and the help sheet; remove the ad-hoc `keydown` handlers in `App.tsx`, `Canvas.tsx`, and `TerminalNode.tsx`.
   - Done when: a command is added in one place, appears in every surface, and shortcut conflicts are shown before assignment.

4. **Session state model and restore policy**
   - Replace the free-form status with `attaching | live | restoring | reconnecting | failed | exited`, plus a reason and the allowed next actions.
   - Decide what survives a renderer reload (the detached host reattaches) versus a quit (today `before-quit` kills every session), and state that precisely in the UI and in `docs/canvas.md`.
   - Done when: unlocking the vault never opens several SSH connections without a single user decision.

5. **Trusted session host**
   - The host listens on `127.0.0.1` with unauthenticated line-JSON; add a per-run token handshake (or a `userData`-scoped pipe) before anything promises persistent sessions.
   - Show host status and a stop action in diagnostics.
   - Done when: another local process cannot attach to the host.

## Wave 1 — Terminal trust

6. **Recovery and launch feedback**
   - Distinguish live attach, replayed output, fresh respawn, and failed restore, then collapse to a quiet status.
   - Per-session phases for host-key verification, authentication, shell startup, and failure.
   - Keep the node in place with an action row: Reconnect, Restart, Close, Copy diagnostics.
   - Done when: a failed launch leaves a node that explains itself (OpenSSH fixture).

7. **Attention and notifications**
   - Trigger on bell, command completion, authentication prompt, and exit of a session whose layer is hidden.
   - Surface in the title bar, sidebar, minimap and layer totals, and optionally as an OS notification.
   - Done when: a session waiting for input in a hidden layer cannot be missed.

8. **Undo stack**
   - Keep the last 10 closures for 60 seconds, with a countdown on the toast; `Ctrl+Z` when the canvas has focus.
   - Undo restores scrollback and follows the restore policy rather than silently reconnecting.
   - Done when: two terminals closed in a row can both be recovered.

9. **First run without the vault wall**
   - Open one working shell immediately; offer vault creation at the first *Save connection*, not before.
   - Three dismissible coach marks: pan/zoom, drag a port to link, hide a layer.
   - Done when: a new user can open a second terminal and link it without opening help.

## Wave 2 — Operate a real workspace

10. **Command palette and shortcut sheet** (on Foundations 3)
    - Searchable commands with recent-first ordering, `Ctrl+K`.
    - Shortcuts visible in menus and context menus; conflicts resolved before assignment.
    - Done when: launch, focus, split, export, restart, and close are all reachable without a pointer.

11. **Workspace switcher**
    - Real workspaces in `layout.json`: name, description, last used, pinned.
    - Snapshot before switching; duplicate, rename, delete, export/import with confirmation.
    - Until this ships, rename the title-bar preset control *View preset*, or remove it.
    - Done when: switching workspaces cannot lose a live session.

12. **Navigation and find**
    - Sidebar filter over title, host, cwd, and note text.
    - Cross-terminal output search over persisted scrollback.
    - Breadcrumb for nested layers, labelled minimap viewport, next/previous terminal by keyboard.
    - Done when: any node is reachable in two keystrokes or one search.

13. **Groups and totals**
    - Group by environment, project, or purpose; layers remain the layout unit.
    - Group actions: reveal, hide, restart, close.
    - Running, stopped, and attention counts per group.
    - Done when: the sidebar answers "what needs me?" without opening nodes.

14. **Layout ergonomics**
    - Snap to grid, alignment guides, equal size, S/M/L default node size.
    - Auto-arrange presets: grid, columns, comparison.
    - Done when: a ten-node layout can be tidied without dragging every node.

## Wave 3 — Differentiate

15. **Shell integration (OSC 7 / OSC 133)**
    - cwd follows the shell, prompt marks, command duration, exit status.
    - Per-command status and "jump to last failure".
    - Done when: the status dot reports a command result, not just process liveness.

16. **Transcripts and markers**
    - Named markers and bookmarks in scrollback.
    - Export with session metadata, chosen time range, and command boundaries.
    - Configurable trim and storage limits for large scrollbacks.
    - Done when: an exported transcript can be read without the app.

17. **Multi-terminal workflows**
    - Broadcast input with an explicit target list and a persistent danger banner.
    - Synchronised scrolling.
    - Move a split pane between nodes.
    - Done when: broadcast cannot reach an unlisted session.

18. **Connection health and templates**
    - Latency and channel state without extra traffic; disconnect reason plus remediation.
    - Connection templates, host groups, jump hosts.
    - Done when: a flaky connection explains itself instead of dropping to a raw error.

## Cross-cutting

19. **Accessibility and motion**
    - `:focus-visible` rings (the stylesheet currently uses bare `outline: none`), full keyboard reachability, shortcut customization.
    - Status shown with text and icon, never colour alone.
    - `prefers-reduced-motion` alternatives for camera movement and node transitions.

20. **Diagnostics and backup**
    - Support bundle excluding passwords, vault contents, keys, and terminal secrets; include app and platform versions, session state, host status, and recent non-sensitive errors.
    - Automatic layout snapshots with restore points; settings backup and restore.

## Explicitly out of scope for now

- Kubernetes shells: Docker and Podman only, by design.
- Embedded RDP: the node keeps launching the native client.
- macOS packaging until a signing identity exists.
- Browser or remote access (`scripts/self-host-server.cjs`) until the session host has a trust model.
- Terminal-to-terminal links beyond visual association; note → terminal is the actionable case.

## Keeping this plan honest

- Anything that ships outside these items (editor/diff nodes, the session board, title-bar presets) is either added here or removed from the product.
- The help sheet may only describe shipped behaviour; update it in the same change as the feature.
- Re-read this list after every release and delete items nobody has asked for.

## Acceptance themes

- A user can understand what a session is doing without reading colour alone.
- A failed launch leaves a recoverable node and a useful next action.
- Closing or switching workspaces cannot silently destroy live session state.
- Common operations can be completed by keyboard, pointer, or command palette.
- Sensitive connection data remains out of layouts, titles, transcripts, and diagnostics.
- New workspace features remain fast at canvas sizes with hundreds of nodes.
- Every advertised feature has a behaviour check and a matching help entry.
