import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CloseIcon } from './icons'

interface Props {
  open: boolean
  onClose: () => void
}

interface Section {
  id: string
  label: string
  body: ReactNode
}

const SHORTCUTS: Array<[string, string]> = [
  ['Ctrl T', 'Shell palette (local shells, WSL, containers)'],
  ['Ctrl Shift C', 'New saved connection'],
  ['Ctrl Shift N', 'New sticky note'],
  ['Ctrl Shift L', 'Lock the vault'],
  ['Ctrl Shift W', 'Close the selected terminal (asks first)'],
  ['Ctrl 0 / Ctrl 1', 'Reset zoom / fit everything'],
  ['Ctrl + wheel', 'Zoom at the pointer'],
  ['F1 / Ctrl /', 'This sheet']
]

const SECTIONS: Section[] = [
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    body: (
      <>
        <p className="help-lead">
          Everything else is on the right-click menus: the canvas, a node, a terminal or a file row.
        </p>
        <dl className="help-keys">
          {SHORTCUTS.map(([keys, description]) => (
            <div key={keys} className="help-key-row">
              <dt>
                <kbd>{keys}</kbd>
              </dt>
              <dd>{description}</dd>
            </div>
          ))}
        </dl>
      </>
    )
  },
  {
    id: 'canvas',
    label: 'Canvas',
    body: (
      <ul className="help-list">
        <li>
          Drag empty canvas to pan, <kbd>Ctrl</kbd> + wheel to zoom (12 %–250 %). The wheel pans, unless
          the pointer is over a terminal – then it scrolls that terminal.
        </li>
        <li>Nodes drag by the header and resize from any of the 8 handles. Double-click a title to rename.</li>
        <li>
          Terminals keep running while you pan away; <strong>Restart</strong> in the header or context menu
          relaunches the shell in its current folder.
        </li>
        <li>Click a terminal to raise it. Stacking is z-order only, so clicks and keyboard focus always land.</li>
        <li>The sidebar lists every node – click one to fly the camera to it.</li>
      </ul>
    )
  },
  {
    id: 'layers',
    label: 'Layers',
    body: (
      <ul className="help-list">
        <li>Layers are folders for terminals. Nested layers, rename by double-click, drag a terminal onto a layer to move it.</li>
        <li>The eye icon hides a layer and everything inside it; hiding a parent hides its children.</li>
        <li>
          Deleting a layer that still holds something asks first: <strong>keep</strong> moves its terminals one
          level up (sessions stay alive), <strong>delete everything</strong> removes the subtree and closes those
          sessions. Empty layers go silently.
        </li>
      </ul>
    )
  },
  {
    id: 'notes',
    label: 'Notes & links',
    body: (
      <ul className="help-list">
        <li>Notes are real nodes: drag, resize, rename, and pick a colour from the note's context menu.</li>
        <li>
          Drag a node's side port onto another node to link them. Click a curve to select it; the × at its
          midpoint removes it.
        </li>
        <li>
          A note linked to a terminal gets a <strong>send</strong> chip that types the note's text into that session
          – no newline, nothing runs until you press Enter.
        </li>
        <li>Notes, titles and links live in the plain-text layout file, so do not keep secrets in them.</li>
      </ul>
    )
  },
  {
    id: 'connections',
    label: 'Connections',
    body: (
      <ul className="help-list">
        <li>
          <strong>SSH</strong> runs <code>ssh -t</code> in a real PTY, so keys, agent and prompts behave exactly
          like your shell. X11 forwarding is a per-connection toggle.
        </li>
        <li>
          <strong>Telnet</strong> is raw TCP with a proper TELNET filter – cleartext by nature, and the editor says
          so.
        </li>
        <li>
          <strong>RDP</strong> opens the platform client in its own window; the node tracks it and offers{' '}
          <em>Reopen</em>.
        </li>
        <li>
          SSH nodes also have a <strong>file browser</strong>: the file icon in the header browses, uploads
          (including drag-and-drop), downloads and deletes over SFTP. The terminal keeps running underneath.
        </li>
        <li>
          Host keys are verified against <code>known_hosts</code> before any credential is sent. An unknown host
          shows its <code>SHA256:</code> fingerprint for you to approve; a changed key is refused with no
          trust-anyway option.
        </li>
      </ul>
    )
  },
  {
    id: 'shells',
    label: 'Shells',
    body: (
      <ul className="help-list">
        <li>
          Detection needs no configuration: PowerShell 7 (and Preview), Windows PowerShell, cmd, Git Bash, MSYS2,
          Cygwin, Nushell, every WSL distro, running Docker/Podman containers, your <code>~/.ssh/config</code>{' '}
          hosts, and on Linux/macOS everything in <code>/etc/shells</code>.
        </li>
        <li>Containers are live handles, not saved profiles – the list refreshes each time the palette opens.</li>
        <li>
          Anything else goes in <code>profiles.json</code> next to the layout file (argv array, never a shell
          string).
        </li>
      </ul>
    )
  },
  {
    id: 'security',
    label: 'Security',
    body: (
      <ul className="help-list">
        <li>
          Saved connections are encrypted with AES-256-GCM under an scrypt-derived key. The master password is
          never stored and never reaches the interface.
        </li>
        <li>The vault locks on demand, after 15 minutes idle, and when the machine sleeps.</li>
        <li>
          Once locked, connection nodes show a placeholder and SFTP channels close; shells that were already
          running keep their sockets until they exit.
        </li>
        <li>
          The layout file (<code>layout.json</code>) is not encrypted – only saved connections are. Host keys you
          approve are kept in a separate <code>known_hosts</code> beside the vault.
        </li>
      </ul>
    )
  }
]

/** The parts of the manual you need while working; the long form lives in docs/. */
export function HelpDialog({ open, onClose }: Props) {
  const [active, setActive] = useState(SECTIONS[0].id)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, onClose])

  if (!open) return null

  const section = SECTIONS.find((entry) => entry.id === active) ?? SECTIONS[0]

  return createPortal(
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div
        className="dialog help-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="TermTerm help"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <h2>TermTerm help</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close help">
            <CloseIcon size={14} />
          </button>
        </header>

        <nav className="help-nav">
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`help-tab${entry.id === section.id ? ' active' : ''}`}
              onClick={() => setActive(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </nav>

        <div className="help-body">{section.body}</div>

        <footer className="help-footer">
          <span>
            Full documentation: <code>docs/</code> in the repository – shells, connections, security model,
            architecture, building and the test suites.
          </span>
        </footer>
      </div>
    </div>,
    document.body
  )
}
