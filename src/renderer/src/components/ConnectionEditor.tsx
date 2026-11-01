import { useEffect, useMemo, useState } from 'react'
import type { ConnectionInput, ConnectionKind, SavedConnection, X11Status } from '@shared/types'
import { CloseIcon, TrashIcon } from './icons'

interface Props {
  open: boolean
  connection: SavedConnection | null
  x11: X11Status | null
  onClose: () => void
  onSaved: (connections: SavedConnection[]) => void
  onDeleted: (connections: SavedConnection[], id: string) => void
}

const DEFAULT_PORT: Record<ConnectionKind, number> = { ssh: 22, telnet: 23, rdp: 3389 }

const KIND_LABEL: Record<ConnectionKind, string> = {
  ssh: 'SSH',
  telnet: 'Telnet',
  rdp: 'RDP'
}

export function ConnectionEditor({ open, connection, x11, onClose, onSaved, onDeleted }: Props) {
  const [kind, setKind] = useState<ConnectionKind>('ssh')
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [username, setUsername] = useState('')
  const [identityFile, setIdentityFile] = useState('')
  const [x11Enabled, setX11Enabled] = useState(false)
  const [x11Trusted, setX11Trusted] = useState(false)
  const [password, setPassword] = useState('')
  const [clearSecret, setClearSecret] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const editing = Boolean(connection)

  useEffect(() => {
    if (!open) return
    setError(null)
    setBusy(false)
    setClearSecret(false)
    if (connection) {
      setKind(connection.kind)
      setName(connection.name)
      setHost(connection.host)
      setPort(String(connection.port ?? DEFAULT_PORT[connection.kind]))
      setUsername(connection.username ?? '')
      setIdentityFile(connection.identityFile ?? '')
      setX11Enabled(Boolean(connection.x11))
      setX11Trusted(Boolean(connection.x11Trusted))
    } else {
      setKind('ssh')
      setName('')
      setHost('')
      setPort(String(DEFAULT_PORT.ssh))
      setUsername('')
      setIdentityFile('')
      setX11Enabled(false)
      setX11Trusted(false)
    }
    setPassword('')
  }, [open, connection])

  const x11Hint = useMemo(() => {
    if (kind !== 'ssh' || !x11Enabled) return null
    if (!x11) return 'Checking for an X server…'
    return x11.available ? `X11 ready – ${x11.detail}` : x11.detail
  }, [kind, x11Enabled, x11])

  if (!open) return null

  const submit = async (): Promise<void> => {
    if (busy) return
    setError(null)
    if (!host.trim()) {
      setError('Host is required.')
      return
    }
    const parsedPort = Number(port)
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setError('Port must be a number between 1 and 65535.')
      return
    }
    const input: ConnectionInput = {
      id: connection?.id,
      name: name.trim() || `${KIND_LABEL[kind]} ${host.trim()}`,
      kind,
      host: host.trim(),
      port: parsedPort,
      username: username.trim() || undefined,
      identityFile: kind === 'ssh' ? identityFile.trim() || undefined : undefined,
      x11: kind === 'ssh' ? x11Enabled : undefined,
      x11Trusted: kind === 'ssh' && x11Enabled ? x11Trusted : undefined,
      password: clearSecret ? null : password ? password : undefined
    }

    setBusy(true)
    try {
      const connections = await window.termterm.saveConnection(input)
      onSaved(connections)
      onClose()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!connection) return
    setBusy(true)
    try {
      const connections = await window.termterm.deleteConnection(connection.id)
      onDeleted(connections, connection.id)
      onClose()
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <form
        className="dialog"
        onPointerDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <header className="dialog-header">
          <h2>{editing ? 'Edit connection' : 'New connection'}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <CloseIcon size={15} />
          </button>
        </header>

        <div className="kind-switch">
          {(['ssh', 'telnet', 'rdp'] as ConnectionKind[]).map((option) => (
            <button
              key={option}
              type="button"
              className={`kind-option${kind === option ? ' active' : ''}`}
              onClick={() => {
                setKind(option)
                setPort(String(DEFAULT_PORT[option]))
              }}
            >
              {KIND_LABEL[option]}
            </button>
          ))}
        </div>

        {kind === 'telnet' ? (
          <div className="banner warning">
            Telnet sends everything – including passwords – in clear text. Use SSH unless the device only supports
            Telnet.
          </div>
        ) : null}
        {kind === 'rdp' ? (
          <div className="banner info">
            Opens the system RDP client in its own window. Windows prompts for credentials itself, so no password is
            handed to the client.
          </div>
        ) : null}

        <div className="field-grid">
          <label className="field span-2">
            <span>Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={`${KIND_LABEL[kind]} ${host || 'host'}`}
              spellCheck={false}
            />
          </label>

          <label className="field">
            <span>Host</span>
            <input
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="server.example.com"
              spellCheck={false}
              autoFocus
            />
          </label>

          <label className="field">
            <span>Port</span>
            <input value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" />
          </label>

          <label className="field">
            <span>Username</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder={kind === 'rdp' ? 'DOMAIN\\user' : 'root'}
              spellCheck={false}
            />
          </label>

          {kind === 'ssh' ? (
            <label className="field">
              <span>Identity file</span>
              <input
                value={identityFile}
                onChange={(event) => setIdentityFile(event.target.value)}
                placeholder="C:\Users\you\.ssh\id_ed25519"
                spellCheck={false}
              />
            </label>
          ) : null}

          {kind === 'telnet' ? (
            <div className="field">
              <span>Password</span>
              <div className="field-note">Typed into the session; never stored.</div>
            </div>
          ) : (
            <div className="field">
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={connection?.hasSecret && !clearSecret ? 'Stored – leave blank to keep' : 'Optional'}
                autoComplete="off"
              />
              {kind === 'ssh' ? (
                <div className="field-note">Stored in the vault and used by the SFTP file browser.</div>
              ) : null}
            </div>
          )}
        </div>

        {kind === 'ssh' ? (
          <div className="switch-row">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={x11Enabled}
                onChange={(event) => setX11Enabled(event.target.checked)}
              />
              <span>X11 forwarding (-X)</span>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={x11Trusted}
                disabled={!x11Enabled}
                onChange={(event) => setX11Trusted(event.target.checked)}
              />
              <span>Trusted (-Y)</span>
            </label>
          </div>
        ) : null}

        {x11Hint ? (
          <div className={`banner ${x11?.available ? 'info' : 'warning'}`}>{x11Hint}</div>
        ) : null}

        {kind === 'rdp' && connection?.hasSecret && !clearSecret ? (
          <button type="button" className="link-button left" onClick={() => setClearSecret(true)}>
            Remove stored password
          </button>
        ) : null}

        {error ? <div className="form-error">{error}</div> : null}

        <footer className="dialog-footer">
          {editing ? (
            <button type="button" className="danger-button" onClick={() => void remove()} disabled={busy}>
              <TrashIcon size={14} />
              Delete
            </button>
          ) : null}
          <span className="spacer" />
          <button type="button" className="ghost-button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary-button inline" disabled={busy}>
            {busy ? 'Saving…' : 'Save connection'}
          </button>
        </footer>
      </form>
    </div>
  )
}
