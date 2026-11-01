import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SavedConnection, SftpEntry, SftpHostKeyChallenge, SftpListing, SftpResult } from '@shared/types'
import { ConfirmDialog } from './ConfirmDialog'
import type { ContextMenuState } from './ContextMenu'
import {
  ArrowUpIcon,
  FileIcon,
  FolderIcon,
  HomeIcon,
  LinkIcon,
  RestartIcon,
  ShieldIcon,
  UploadIcon
} from './icons'

interface Props {
  connection: SavedConnection
  openMenu: (menu: ContextMenuState) => void
}

interface Editor {
  mode: 'new' | 'rename'
  entry?: SftpEntry
  value: string
}

function parentOf(path: string): string {
  if (path === '/' || path.length === 0) return '/'
  const index = path.replace(/\/+$/, '').lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

function formatDate(ms: number): string {
  if (!ms) return ''
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  const day = date.toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: '2-digit' })
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return `${day} ${time}`
}

/** SFTP file browser for a saved SSH connection; all secrets stay in the main process. */
export function SftpPanel({ connection, openMenu }: Props) {
  const [listing, setListing] = useState<SftpListing | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [challenge, setChallenge] = useState<SftpHostKeyChallenge | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [pendingDelete, setPendingDelete] = useState<SftpEntry | null>(null)
  const path = listing?.path ?? ''

  const handle = useCallback(async <T,>(action: Promise<SftpResult<T>>, onOk?: (value: T) => void) => {
    setBusy(true)
    try {
      const result = await action
      if (!result.ok) {
        setError(result.error)
        setChallenge(result.hostKey ?? null)
        return false
      }
      setError('')
      setChallenge(null)
      onOk?.(result.value)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  const openPath = useCallback(
    (target?: string) =>
      handle(window.termterm.sftpList(connection.id, target), (value) => {
        setListing(value)
        setSelected(null)
      }),
    [connection.id, handle]
  )

  useEffect(() => {
    void openPath()
    return () => window.termterm.sftpDisconnect(connection.id)
  }, [connection.id, openPath])

  const reload = (): void => {
    void openPath(path || undefined)
  }

  const download = (entry: SftpEntry): void => {
    void handle(window.termterm.sftpDownload(connection.id, entry.path), (value) => {
      if (value) setNote(`Saved ${value.path}`)
    })
  }

  const enter = (entry: SftpEntry): void => {
    if (entry.kind === 'dir') {
      void openPath(entry.path)
      return
    }
    if (entry.kind === 'link') {
      // A link may point at a folder, so ask the server before deciding.
      void handle(window.termterm.sftpStat(connection.id, entry.path), (value) => {
        if (value.kind === 'dir') void openPath(entry.path)
        else download(entry)
      })
      return
    }
    download(entry)
  }

  const upload = (): void => {
    void handle(window.termterm.sftpUpload(connection.id, path), (value) => {
      if (value.uploaded.length === 0) return
      setNote(`Uploaded ${value.uploaded.length} file${value.uploaded.length === 1 ? '' : 's'}`)
      void openPath(path)
    })
  }

  const uploadDropped = (event: React.DragEvent): void => {
    event.preventDefault()
    const localPaths: string[] = []
    for (const file of Array.from(event.dataTransfer.files)) {
      try {
        const localPath = window.termterm.pathForFile(file)
        if (localPath) localPaths.push(localPath)
      } catch {
        // Dropped items without a local path (e.g. dragged text) are ignored.
      }
    }
    if (localPaths.length === 0) return
    void handle(window.termterm.sftpUploadFiles(connection.id, path, localPaths), (value) => {
      setNote(`Uploaded ${value.uploaded.length} file${value.uploaded.length === 1 ? '' : 's'}`)
      void openPath(path)
    })
  }

  const commitEditor = (): void => {
    if (!editor) return
    const value = editor.value.trim()
    const draft = editor
    setEditor(null)
    if (value.length === 0) return
    if (draft.mode === 'new') {
      void handle(window.termterm.sftpMkdir(connection.id, path, value), () => {
        setNote(`Created ${value}`)
        void openPath(path)
      })
      return
    }
    void handle(window.termterm.sftpRename(connection.id, draft.entry!.path, value), () => {
      setNote(`Renamed to ${value}`)
      void openPath(path)
    })
  }

  const remove = (entry: SftpEntry): void => {
    // Deletions are irreversible on the remote host, so they always ask first.
    setPendingDelete(entry)
  }

  const trust = (): void => {
    if (!challenge) return
    void handle(window.termterm.sftpTrustHost(connection.id, challenge.fingerprint), () => {
      setNote(`Trusted ${challenge.host}`)
      void openPath()
    })
  }

  const rowMenu = (event: React.MouseEvent, entry: SftpEntry): void => {
    event.preventDefault()
    event.stopPropagation()
    setSelected(entry.path)
    openMenu({
      x: event.clientX,
      y: event.clientY,
      entries: [
        entry.kind === 'dir'
          ? { label: 'Open', onSelect: () => enter(entry) }
          : { label: 'Download…', onSelect: () => download(entry) },
        { label: 'Rename…', onSelect: () => setEditor({ mode: 'rename', entry, value: entry.name }) },
        'separator',
        { label: entry.kind === 'dir' ? 'Delete folder…' : 'Delete', danger: true, onSelect: () => remove(entry) }
      ]
    })
  }

  return (
    <div className="sftp-panel" onDragOver={(event) => event.preventDefault()} onDrop={uploadDropped}>
      <div className="sftp-toolbar">
        <button
          type="button"
          className="icon-button"
          title="Parent folder"
          disabled={busy || path === '/'}
          onClick={() => void openPath(parentOf(path))}
        >
          <ArrowUpIcon size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          title="Home folder"
          disabled={busy || !listing}
          onClick={() => void openPath(listing?.home)}
        >
          <HomeIcon size={14} />
        </button>
        <span className="sftp-path" title={path}>
          {path || 'connecting…'}
        </span>
        <button type="button" className="icon-button" title="Refresh" disabled={busy} onClick={reload}>
          <RestartIcon size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          title="New folder"
          disabled={busy || !listing}
          onClick={() => setEditor({ mode: 'new', value: '' })}
        >
          <FolderIcon size={14} />
        </button>
        <button type="button" className="icon-button" title="Upload files…" disabled={busy || !listing} onClick={upload}>
          <UploadIcon size={14} />
        </button>
      </div>

      {editor ? (
        <div className="sftp-inline">
          <input
            autoFocus
            spellCheck={false}
            value={editor.value}
            placeholder={editor.mode === 'new' ? 'New folder name' : 'New name'}
            onChange={(event) => setEditor({ ...editor, value: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitEditor()
              if (event.key === 'Escape') setEditor(null)
            }}
          />
          <button type="button" className="mini-button" onClick={commitEditor}>
            Save
          </button>
          <button type="button" className="mini-button" onClick={() => setEditor(null)}>
            Cancel
          </button>
        </div>
      ) : null}

      {challenge ? (
        <div className="sftp-trust">
          <ShieldIcon size={16} />
          <div className="sftp-trust-body">
            <p>
              The host key for <strong>{challenge.host}</strong> is not trusted yet. Check it before continuing.
            </p>
            <code>
              {challenge.keyType} {challenge.fingerprint}
            </code>
            <div className="sftp-trust-actions">
              <button type="button" className="mini-button primary" onClick={trust} disabled={busy}>
                Trust this host
              </button>
              <button type="button" className="mini-button" onClick={() => void openPath()} disabled={busy}>
                Retry
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="sftp-list">
        {error && !challenge ? <div className="sftp-alert">{error}</div> : null}
        {!listing && busy ? <div className="sftp-empty">Connecting…</div> : null}
        {listing && listing.entries.length === 0 ? <div className="sftp-empty">This folder is empty.</div> : null}
        {listing?.entries.map((entry) => (
          <div
            key={entry.path}
            className={`sftp-row${selected === entry.path ? ' selected' : ''}`}
            title={entry.name}
            onClick={() => setSelected(entry.path)}
            onDoubleClick={() => enter(entry)}
            onContextMenu={(event) => rowMenu(event, entry)}
          >
            <span className={`sftp-icon ${entry.kind}`}>
              {entry.kind === 'dir' ? (
                <FolderIcon size={13} />
              ) : entry.kind === 'link' ? (
                <LinkIcon size={13} />
              ) : (
                <FileIcon size={13} />
              )}
            </span>
            <span className="sftp-name">{entry.name}</span>
            <span className="sftp-size">{entry.kind === 'dir' ? '' : formatSize(entry.size)}</span>
            <span className="sftp-date">{formatDate(entry.modified)}</span>
          </div>
        ))}
      </div>

      <div className={`sftp-footer${error ? ' error' : ''}`}>
        <span className="sftp-message">
          {note || (selected ? 'Double-click to open · right-click for actions' : '')}
        </span>
        <span className="sftp-count">
          {listing ? `${listing.entries.length} item${listing.entries.length === 1 ? '' : 's'}` : ''}
        </span>
      </div>

      {createPortal(
        <ConfirmDialog
          open={pendingDelete !== null}
          title={pendingDelete?.kind === 'dir' ? 'Delete folder?' : 'Delete file?'}
          body={
            <p>
              <strong>{pendingDelete?.name}</strong>
              {pendingDelete?.kind === 'dir'
                ? ' and everything inside it will be deleted from the remote host.'
                : ' will be deleted from the remote host.'}{' '}
              This cannot be undone.
            </p>
          }
          choices={[
            {
              label: pendingDelete?.kind === 'dir' ? 'Delete folder' : 'Delete file',
              tone: 'danger',
              hint: pendingDelete?.kind === 'dir' ? 'Removes every file inside it' : pendingDelete?.path,
              onSelect: () => {
                const entry = pendingDelete
                if (!entry) return
                void handle(window.termterm.sftpRemove(connection.id, entry.path, entry.kind), (count) => {
                  setNote(`Deleted ${count} item${count === 1 ? '' : 's'}`)
                  void openPath(path)
                })
              }
            }
          ]}
          onClose={() => setPendingDelete(null)}
        />,
        document.body
      )}
    </div>
  )
}
