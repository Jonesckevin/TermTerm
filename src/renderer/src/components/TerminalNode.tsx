import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import type { SavedConnection, ShellProfile, TerminalNodeModel } from '@shared/types'
import { ptyBus } from '@/lib/ptyBus'
import { RESIZE_HANDLES, useNodeFrame } from '@/lib/useNodeFrame'
import { useAppStore } from '@/state/useAppStore'
import type { SessionStatus } from '@/state/useAppStore'
import { ProfileBadge } from './ProfileBadge'
import { SftpPanel } from './SftpPanel'
import { CloseIcon, DownloadIcon, FileIcon, FolderIcon, GridIcon, LockIcon, RestartIcon, SearchIcon } from './icons'
import type { ContextMenuState } from './ContextMenu'

const BASE_FONT_SIZE = 13
const REFIT_DELAY_MS = 130
const ANSI_ESCAPE_PATTERN =
  // CSI and OSC sequences are emitted by terminal serialization but are not useful in text logs.
  /[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*\u001B?)|(?:\d{1,4}(?:;\d{0,4})*)?)/

function terminalPlainText(serialized: string): string {
  return serialized
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(/\r/g, '')
    .replace(/[^\x09\x0A\x20-\x7e\u00a0-\uffff]/g, '')
    .trimEnd()
}

const TERMINAL_THEME = {
  background: '#111114',
  foreground: '#d7d7dc',
  cursor: '#ff6d5a',
  cursorAccent: '#111114',
  selectionBackground: 'rgba(255, 109, 90, 0.32)',
  black: '#1b1b20',
  red: '#f2777a',
  green: '#9ecb8b',
  yellow: '#e6c07b',
  blue: '#78a9e0',
  magenta: '#c79ae0',
  cyan: '#6fc7c7',
  white: '#d7d7dc',
  brightBlack: '#6b6b77',
  brightRed: '#ff8f8f',
  brightGreen: '#b7e8a8',
  brightYellow: '#f5d69a',
  brightBlue: '#94bfff',
  brightMagenta: '#dcb2f0',
  brightCyan: '#8fe0e0',
  brightWhite: '#ffffff'
}

interface Props {
  node: TerminalNodeModel
  profile?: ShellProfile
  connection?: SavedConnection
  zoom: number
  selected: boolean
  zIndex?: number
  openMenu: (menu: ContextMenuState) => void
  onStartLink: (nodeId: string, event: React.PointerEvent) => void
}

export function TerminalNode({ node, profile, connection, zoom, selected, zIndex, openMenu, onStartLink }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const splitHostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const splitTermRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const splitFitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const serializeRef = useRef<SerializeAddon | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const aliveRef = useRef(false)
  const [fittedZoom, setFittedZoom] = useState(zoom)
  const [launched, setLaunched] = useState<string | null>(null)
  const status: SessionStatus = useAppStore((state) => state.statuses[node.id] ?? 'starting')
  const setStatus = useAppStore((state) => state.setStatus)
  const [editing, setEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState(node.title)
  const [view, setView] = useState<'terminal' | 'files'>('terminal')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResult, setSearchResult] = useState('')
  const scrollbackTimerRef = useRef<number | undefined>(undefined)
  const scrollbackRef = useRef(node.scrollback ?? '')

  const updateNode = useAppStore((state) => state.updateNode)
  const requestCloseNode = useAppStore((state) => state.requestCloseNode)
  const selectNode = useAppStore((state) => state.selectNode)
  const bringToFront = useAppStore((state) => state.bringToFront)
  const { beginDrag, beginResize } = useNodeFrame(node)
  const splitSessionId = node.splitPaneId

  const isConnectionNode = Boolean(node.connectionId)
  // A connection node whose vault is locked has nothing to resolve against.
  const blocked = isConnectionNode && !connection
  const canBrowseFiles = connection?.kind === 'ssh'
  const showFiles = canBrowseFiles && view === 'files'
  const badge = profile ?? connection
  const subtitle = connection ? `${connection.kind}://${connection.host}` : node.cwd || ''
  // Auto titles never contain a hostname; only user renames are persisted verbatim.
  const displayTitle = node.titleCustom ? node.title : (connection?.name ?? node.title)

  const startSession = useCallback(async () => {
    const term = termRef.current
    if (!term) return
    setStatus(node.id, 'starting')
    if (node.connectionId) setStatus(node.id, 'connecting')
    try {
      const result = await window.termterm.spawn({
        nodeId: node.id,
        ...(node.connectionId ? { connectionId: node.connectionId } : { profileId: node.profileId }),
        cwd: node.cwd,
        cols: Math.max(2, term.cols),
        rows: Math.max(2, term.rows)
      })
      if (!aliveRef.current) {
        window.termterm.kill(node.id)
        return
      }
      if (result.replay) {
        const replay = scrollbackRef.current && result.replay.startsWith(scrollbackRef.current)
          ? result.replay.slice(scrollbackRef.current.length)
          : result.replay
        if (replay) term.write(replay, () => term.scrollToBottom())
      }
      setStatus(node.id, 'running')
      if (result.warning) {
        term.writeln(`\x1b[33m⚠ ${result.warning}\x1b[0m`)
      }
      if (result.external) {
        setLaunched(result.launched ?? 'external session')
        term.writeln(`\x1b[38;5;244m${result.launched ?? 'Session launched'} – output appears in its own window.\x1b[0m`)
      }
      if (result.cwd && result.cwd !== node.cwd) updateNode(node.id, { cwd: result.cwd })
    } catch (error) {
      if (!aliveRef.current) return
      setStatus(node.id, 'error')
      term.writeln(`\x1b[31mCould not start ${connection?.name ?? profile?.name ?? 'session'}\x1b[0m`)
      term.writeln(`\x1b[38;5;244m${error instanceof Error ? error.message : String(error)}\x1b[0m`)
    }
  }, [node.id, node.connectionId, node.profileId, node.cwd, connection?.name, profile?.name, setStatus, updateNode])

  // Terminal lifecycle: one xterm instance per node, kept alive across restarts.
  useEffect(() => {
    const host = hostRef.current
    if (!host || blocked) return
    aliveRef.current = true
    ptyBus.ensureBound()

    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "DejaVu Sans Mono", monospace',
      fontSize: BASE_FONT_SIZE,
      lineHeight: 1.25,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 8000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: TERMINAL_THEME
    })
    termRef.current = term

    const fitAddon = new FitAddon()
    fitRef.current = fitAddon
    term.loadAddon(fitAddon)
    const searchAddon = new SearchAddon()
    searchRef.current = searchAddon
    term.loadAddon(searchAddon)
    const serializeAddon = new SerializeAddon()
    serializeRef.current = serializeAddon
    term.loadAddon(serializeAddon)
    term.loadAddon(new WebLinksAddon())
    term.open(host)
    if (scrollbackRef.current) {
      term.write(scrollbackRef.current, () => {
        term.scrollToBottom()
      })
    }

    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // Falls back to the DOM renderer on machines without a usable GPU context.
    }

    const dataDisposable = term.onData((data) => window.termterm.write(node.id, data))
    const offData = ptyBus.onData(node.id, (data) => {
      term.write(data)
      scrollbackRef.current = `${scrollbackRef.current}${data}`.slice(-200_000)
      window.clearTimeout(scrollbackTimerRef.current)
      scrollbackTimerRef.current = window.setTimeout(() => {
        updateNode(node.id, { scrollback: scrollbackRef.current })
      }, 750)
    })
    const offExit = ptyBus.onExit(node.id, ({ exitCode }) => {
      setStatus(node.id, 'exited')
      term.writeln(`\r\n\x1b[38;5;244m[process exited with code ${exitCode}]\x1b[0m`)
    })

    requestAnimationFrame(() => {
      try {
        fitAddon.fit()
      } catch {
        // host may not be measured yet
      }
      void startSession()
    })

    return () => {
      aliveRef.current = false
      offData()
      offExit()
      dataDisposable.dispose()
      window.termterm.kill(node.id)
      term.dispose()
      window.clearTimeout(scrollbackTimerRef.current)
      updateNode(node.id, { scrollback: scrollbackRef.current })
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
      serializeRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id, blocked])

  useEffect(() => {
    const timer = setTimeout(() => setFittedZoom(zoom), REFIT_DELAY_MS)
    return () => clearTimeout(timer)
  }, [zoom])

  useEffect(() => {
    if (!selected) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        event.stopPropagation()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [selected])

  useEffect(() => {
    if (!searchOpen) return
    const timer = window.setTimeout(() => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    }, 20)
    return () => window.clearTimeout(timer)
  }, [searchOpen])

  // Locking the vault removes the connection, so drop back to the placeholder.
  useEffect(() => {
    if (blocked) setView('terminal')
  }, [blocked])

  useLayoutEffect(() => {
    const term = termRef.current
    const fitAddon = fitRef.current
    if (!term || !fitAddon) return
    term.options.fontSize = Math.max(6, Math.round(BASE_FONT_SIZE * fittedZoom))
    try {
      fitAddon.fit()
    } catch {
      return
    }
    window.termterm.resize(node.id, term.cols, term.rows)
  }, [fittedZoom, node.w, node.h, node.id])

  useEffect(() => {
    const host = splitHostRef.current
    if (!host || !splitSessionId || blocked) return
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "DejaVu Sans Mono", monospace',
      fontSize: BASE_FONT_SIZE,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 8000,
      allowProposedApi: true,
      theme: TERMINAL_THEME
    })
    const fitAddon = new FitAddon()
    splitTermRef.current = term
    splitFitRef.current = fitAddon
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())
    term.open(host)
    fitAddon.fit()

    const dataDisposable = term.onData((data) => window.termterm.write(splitSessionId, data))
    const offData = ptyBus.onData(splitSessionId, (data) => term.write(data))
    const offExit = ptyBus.onExit(splitSessionId, ({ exitCode }) => {
      term.writeln(`\r\n\x1b[38;5;244m[pane exited with code ${exitCode}]\x1b[0m`)
    })

    setStatus(splitSessionId, 'starting')
    requestAnimationFrame(() => {
      void window.termterm.spawn({
        nodeId: splitSessionId,
        ...(node.connectionId ? { connectionId: node.connectionId } : { profileId: node.profileId }),
        cwd: node.cwd,
        cols: Math.max(2, term.cols),
        rows: Math.max(2, term.rows)
      }).then(() => setStatus(splitSessionId, 'running')).catch((error: unknown) => {
        setStatus(splitSessionId, 'error')
        term.writeln(`\r\n\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m`)
      })
    })

    return () => {
      offData()
      offExit()
      dataDisposable.dispose()
      window.termterm.kill(splitSessionId)
      term.dispose()
      splitTermRef.current = null
      splitFitRef.current = null
    }
  }, [splitSessionId, blocked, node.connectionId, node.profileId, node.cwd, setStatus])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const term = splitTermRef.current
      const fitAddon = splitFitRef.current
      if (!term || !fitAddon) return
      term.options.fontSize = Math.max(6, Math.round(BASE_FONT_SIZE * fittedZoom))
      fitAddon.fit()
      if (splitSessionId) window.termterm.resize(splitSessionId, term.cols, term.rows)
    }, REFIT_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [fittedZoom, node.w, node.h, splitSessionId])

  const restart = useCallback(() => {
    const term = termRef.current
    window.termterm.kill(node.id)
    term?.reset()
    setLaunched(null)
    setStatus(node.id, 'starting')
    void startSession()
  }, [node.id, setStatus, startSession])

  const toggleSplit = useCallback(() => {
    if (node.splitPaneId) {
      window.termterm.kill(node.splitPaneId)
      updateNode(node.id, { splitPaneId: undefined })
      return
    }
    updateNode(node.id, { splitPaneId: crypto.randomUUID() })
  }, [node.id, node.splitPaneId, updateNode])

  const runSearch = useCallback((direction: 'next' | 'previous' = 'next'): void => {
    const addon = searchRef.current
    if (!addon || !searchQuery) {
      setSearchResult('')
      return
    }
    const found = direction === 'next'
      ? addon.findNext(searchQuery, { incremental: true })
      : addon.findPrevious(searchQuery)
    setSearchResult(found ? '' : 'No matches')
  }, [searchQuery])

  const closeSearch = useCallback(() => {
    searchRef.current?.clearDecorations()
    setSearchOpen(false)
    setSearchQuery('')
    setSearchResult('')
  }, [])

  const exportTerminal = useCallback(async (): Promise<void> => {
    const serialized = serializeRef.current?.serialize()
    if (serialized === undefined) return
    const suggestedName = displayTitle.replace(/\s+/g, '-').toLowerCase() || 'terminal'
    await window.termterm.exportTerminal(terminalPlainText(serialized), suggestedName)
  }, [displayTitle])

  const openTerminalMenu = (event: React.MouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    const term = termRef.current
    const hasSelection = Boolean(term?.hasSelection())
    openMenu({
      x: event.clientX,
      y: event.clientY,
      entries: [
        {
          label: node.splitPaneId ? 'Close split pane' : 'Split terminal right',
          onSelect: toggleSplit
        },
        {
          label: 'Search terminal',
          shortcut: 'Ctrl+F',
          disabled: blocked,
          onSelect: () => setSearchOpen(true)
        },
        {
          label: 'Export scrollback…',
          disabled: blocked,
          onSelect: () => void exportTerminal()
        },
        'separator',
        {
          label: 'Copy',
          shortcut: 'Ctrl+Shift+C',
          disabled: !hasSelection,
          onSelect: () => {
            const selection = term?.getSelection()
            if (selection) void navigator.clipboard.writeText(selection)
          }
        },
        {
          label: 'Paste',
          shortcut: 'Ctrl+Shift+V',
          onSelect: () => {
            navigator.clipboard
              .readText()
              .then((text) => term?.paste(text))
              .catch(() => undefined)
          }
        },
        { label: 'Select all', onSelect: () => term?.selectAll() },
        { label: 'Clear buffer', onSelect: () => term?.clear() },
        'separator',
        ...(canBrowseFiles
          ? [{ label: 'Browse files (SFTP)…', onSelect: () => setView('files') }]
          : []),
        ...(isConnectionNode
          ? []
          : [
              {
                label: node.cwd ? 'Restart in another folder…' : 'Start in a folder…',
                onSelect: () => {
                  void window.termterm.pickDirectory().then((directory) => {
                    if (!directory) return
                    updateNode(node.id, { cwd: directory })
                    restart()
                  })
                }
              }
            ]),
        { label: 'Restart session', onSelect: restart },
        'separator',
        { label: 'Close terminal', danger: true, onSelect: () => requestCloseNode(node.id) }
      ]
    })
  }

  const commitTitle = (): void => {
    const title = draftTitle.trim()
    setEditing(false)
    if (title.length > 0 && title !== displayTitle) updateNode(node.id, { title })
    else if (title.length === 0) setDraftTitle(displayTitle)
  }

  const style = {
    '--nx': node.x,
    '--ny': node.y,
    '--nw': node.w,
    '--nh': node.h,
    '--fitted': fittedZoom,
    '--accent': badge?.accent ?? '#ff6d5a',
    zIndex: zIndex ?? 1
  } as CSSProperties

  return (
    <section
      className={`node${selected ? ' selected' : ''}${status === 'exited' ? ' exited' : ''}`}
      style={style}
      data-node-id={node.id}
      onPointerDown={() => {
        selectNode(node.id)
        bringToFront(node.id)
      }}
      onContextMenu={openTerminalMenu}
    >
      <div className="node-port left" title="Drag to link" onPointerDown={(event) => onStartLink(node.id, event)} />
      <div className="node-port right" title="Drag to link" onPointerDown={(event) => onStartLink(node.id, event)} />

      <header
        className="node-header"
        onPointerDown={beginDrag}
        onDoubleClick={() => {
          setDraftTitle(displayTitle)
          setEditing(true)
        }}
      >
        <ProfileBadge profile={badge} size={20} />
        {editing ? (
          <input
            className="node-title-input"
            value={draftTitle}
            autoFocus
            spellCheck={false}
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitTitle()
              if (event.key === 'Escape') {
                setDraftTitle(displayTitle)
                setEditing(false)
              }
            }}
          />
        ) : (
          <span className="node-title" title={subtitle || displayTitle}>
            {displayTitle}
          </span>
        )}
        {isConnectionNode ? <span className="node-kind">{connection?.kind ?? 'locked'}</span> : null}
        <span
          className={`node-status ${status}`}
          role="status"
          aria-label={`Session ${status}`}
          title={`Session: ${status}`}
        />
        <div className="node-actions">
          <button
            type="button"
            className={`icon-button${node.splitPaneId ? ' active' : ''}`}
            title={node.splitPaneId ? 'Close split pane' : 'Split terminal right'}
            disabled={blocked}
            onClick={toggleSplit}
          >
            <GridIcon size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Export scrollback…"
            disabled={blocked}
            onClick={() => void exportTerminal()}
          >
            <DownloadIcon size={14} />
          </button>
          <button
            type="button"
            className={`icon-button${searchOpen ? ' active' : ''}`}
            title="Search terminal (Ctrl+F)"
            disabled={blocked}
            onClick={() => setSearchOpen((open) => !open)}
          >
            <SearchIcon size={14} />
          </button>
          {canBrowseFiles ? (
            <button
              type="button"
              className={`icon-button${showFiles ? ' active' : ''}`}
              title={showFiles ? 'Back to the terminal' : 'Browse files (SFTP)'}
              disabled={blocked}
              onClick={() => setView(showFiles ? 'terminal' : 'files')}
            >
              <FileIcon size={14} />
            </button>
          ) : null}
          {isConnectionNode || blocked ? null : (
            <button
              type="button"
              className="icon-button"
              title="Start in folder…"
              onClick={() => {
                void window.termterm.pickDirectory().then((directory) => {
                  if (!directory) return
                  updateNode(node.id, { cwd: directory })
                  restart()
                })
              }}
            >
              <FolderIcon size={14} />
            </button>
          )}
          <button type="button" className="icon-button" title="Restart session" onClick={restart} disabled={blocked}>
            <RestartIcon size={14} />
          </button>
          <button type="button" className="icon-button" title="Close terminal" onClick={() => requestCloseNode(node.id)}>
            <CloseIcon size={14} />
          </button>
        </div>
      </header>

      <div className="node-body">
        {searchOpen && !blocked ? (
          <div className="terminal-search" role="search">
            <SearchIcon size={14} />
            <input
              ref={searchInputRef}
              value={searchQuery}
              placeholder="Find in terminal"
              spellCheck={false}
              onChange={(event) => {
                const query = event.target.value
                setSearchQuery(query)
                if (!query) {
                  searchRef.current?.clearDecorations()
                  setSearchResult('')
                  return
                }
                const found = searchRef.current?.findNext(query, { incremental: true }) ?? false
                setSearchResult(found ? '' : 'No matches')
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  closeSearch()
                } else if (event.key === 'Enter') {
                  event.preventDefault()
                  runSearch(event.shiftKey ? 'previous' : 'next')
                }
              }}
            />
            {searchResult ? <span className="terminal-search-status">{searchResult}</span> : null}
            <button type="button" className="mini-button" title="Previous match (Shift+Enter)" onClick={() => runSearch('previous')}>
              ↑
            </button>
            <button type="button" className="mini-button" title="Next match (Enter)" onClick={() => runSearch('next')}>
              ↓
            </button>
            <button type="button" className="icon-button tiny" title="Close search" onClick={closeSearch}>
              <CloseIcon size={13} />
            </button>
          </div>
        ) : null}
        {blocked ? (
          <div className="node-placeholder">
            <LockIcon size={18} />
            <span>This connection is stored in your vault. Unlock it to start the session.</span>
          </div>
        ) : (
          <div className={`terminal-panes${node.splitPaneId ? ' split' : ''}`}>
            <div className="terminal-host" ref={hostRef} />
            {node.splitPaneId ? <div className="terminal-pane-divider" /> : null}
            {node.splitPaneId ? <div className="terminal-host split-host" ref={splitHostRef} /> : null}
          </div>
        )}

        {status === 'connecting' && !blocked ? (
          <div className="node-connection-banner" role="status">
            Connecting to {connection?.host ?? 'remote host'}…
          </div>
        ) : null}

        {showFiles && connection ? <SftpPanel connection={connection} openMenu={openMenu} /> : null}

        {launched && status === 'running' ? (
          <div className="node-external-banner">
            <span>{launched}</span>
            <button type="button" className="mini-button" onClick={restart}>
              Reopen
            </button>
          </div>
        ) : null}

        {(status === 'exited' || status === 'error') && !blocked ? (
          <button type="button" className="node-restart-overlay" onClick={restart}>
            Session ended – click to start a new one
          </button>
        ) : null}
      </div>

      {RESIZE_HANDLES.map((direction) => (
        <div
          key={direction}
          className={`resize-handle ${direction}`}
          onPointerDown={(event) => beginResize(event, direction)}
        />
      ))}
    </section>
  )
}
