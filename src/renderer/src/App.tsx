import { useCallback, useEffect, useState } from 'react'
import type { SavedConnection, X11Status } from '@shared/types'
import { Canvas } from './components/Canvas'
import { ConnectionEditor } from './components/ConnectionEditor'
import { CloseNodeDialog } from './components/CloseNodeDialog'
import { ContextMenu, type ContextMenuState } from './components/ContextMenu'
import { HelpDialog } from './components/HelpDialog'
import { LockScreen } from './components/LockScreen'
import { ProfilePicker } from './components/ProfilePicker'
import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { ptyBus } from './lib/ptyBus'
import { useAppStore } from './state/useAppStore'
import { KanbanView } from './components/KanbanView'

const IDLE_LOCK_MS = 15 * 60 * 1000

type LockPrompt = 'closed' | 'create' | 'unlock'

function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  // Electron prefixes rejected invoke errors; keep the human-readable tail.
  const tail = raw.split('Error: ').pop() ?? raw
  return tail.replace(/^Error invoking remote method '[^']+':\s*/, '')
}

export function App() {
  const ready = useAppStore((state) => state.ready)
  const profiles = useAppStore((state) => state.profiles)
  const vault = useAppStore((state) => state.vault)
  const connections = useAppStore((state) => state.connections)
  const lastRemoved = useAppStore((state) => state.lastRemoved)

  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerWorld, setPickerWorld] = useState<{ x: number; y: number } | undefined>(undefined)
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const [lockPrompt, setLockPrompt] = useState<LockPrompt>('closed')
  const [lockBusy, setLockBusy] = useState(false)
  const [lockError, setLockError] = useState<string | null>(null)
  const [editorConnection, setEditorConnection] = useState<SavedConnection | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [x11, setX11] = useState<X11Status | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [kanbanOpen, setKanbanOpen] = useState(false)

  useEffect(() => {
    ptyBus.ensureBound()
    let cancelled = false
    void Promise.all([
      window.termterm.listProfiles(),
      window.termterm.loadLayout(),
      window.termterm.vaultStatus()
    ])
      .then(([detectedProfiles, layout, vaultStatus]) => {
        if (cancelled) return
        useAppStore.getState().hydrate(layout, detectedProfiles, vaultStatus)
        if (!vaultStatus.exists) setLockPrompt('create')
        else if (!vaultStatus.unlocked) setLockPrompt('unlock')
        void window.termterm.x11Status().then(setX11).catch(() => setX11(null))
      })
      .catch((error: unknown) => {
        console.error('TermTerm failed to initialise', error)
        useAppStore.getState().hydrate(null, [], { exists: false, unlocked: false, connectionCount: 0 })
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    return window.termtermEvents.onVaultLocked((status) => {
      useAppStore.getState().lockVaultState(status)
      setLockPrompt('unlock')
    })
  }, [])

  useEffect(() => {
    if (!ready) return
    let timer: number | undefined
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (
        state.nodes === previous.nodes &&
        state.camera === previous.camera &&
        state.layers === previous.layers &&
        state.links === previous.links
      ) {
        return
      }
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const current = useAppStore.getState()
        window.termterm.saveLayout({
          version: 3,
          nodes: current.nodes,
          layers: current.layers,
          links: current.links,
          camera: current.camera
        })
      }, 400)
    })
    return () => {
      unsubscribe()
      window.clearTimeout(timer)
    }
  }, [ready])

  // Auto-lock after a period of inactivity while the vault is open.
  useEffect(() => {
    if (!vault.unlocked) return
    let timer = window.setTimeout(() => void lock(), IDLE_LOCK_MS)
    const reset = (): void => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void lock(), IDLE_LOCK_MS)
    }
    const events = ['pointerdown', 'keydown', 'wheel'] as const
    for (const event of events) window.addEventListener(event, reset, true)
    return () => {
      window.clearTimeout(timer)
      for (const event of events) window.removeEventListener(event, reset, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault.unlocked])

  const lock = useCallback(async (): Promise<void> => {
    try {
      const status = await window.termterm.vaultLock()
      useAppStore.getState().lockVaultState(status)
      setLockPrompt('unlock')
    } catch (error) {
      console.error('Failed to lock vault', error)
    }
  }, [])

  const requestNewTerminal = useCallback((world?: { x: number; y: number }) => {
    setPickerWorld(world)
    setPickerOpen(true)
    // Containers come and go, so re-detect whenever the palette opens.
    void window.termterm
      .refreshProfiles()
      .then((list) => useAppStore.getState().setProfiles(list))
      .catch(() => undefined)
  }, [])

  const closePicker = useCallback(() => {
    setPickerOpen(false)
    setPickerWorld(undefined)
  }, [])

  const openConnectionEditor = useCallback((connection: SavedConnection | null) => {
    setEditorConnection(connection)
    setEditorOpen(true)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Help has no modifier, so it is handled before the Ctrl-based shortcuts.
      if (event.key === 'F1' || ((event.ctrlKey || event.metaKey) && event.key === '/')) {
        event.preventDefault()
        event.stopPropagation()
        setHelpOpen((open) => !open)
        return
      }

      const mod = event.ctrlKey || event.metaKey
      if (!mod) return
      const key = event.key.toLowerCase()

      if (key === 't' && !event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        requestNewTerminal()
        return
      }
      if (key === 'n' && event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        useAppStore.getState().addNote()
        return
      }
      if (key === 'e' && event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        useAppStore.getState().addEditor('editor')
        return
      }
      if (key === 'd' && event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        useAppStore.getState().addEditor('diff')
        return
      }
      if (key === 'c' && event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        if (useAppStore.getState().vault.unlocked) openConnectionEditor(null)
        else if (useAppStore.getState().vault.exists) setLockPrompt('unlock')
        return
      }
      if (key === 'l' && event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        void lock()
        return
      }
      if (key === '0') {
        event.preventDefault()
        event.stopPropagation()
        useAppStore.getState().resetZoom()
        return
      }
      if (key === '1') {
        event.preventDefault()
        event.stopPropagation()
        useAppStore.getState().fitAll()
        return
      }
      if (key === 'w' && event.shiftKey) {
        const { selectedId, requestCloseNode } = useAppStore.getState()
        if (!selectedId) return
        event.preventDefault()
        event.stopPropagation()
        requestCloseNode(selectedId)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [requestNewTerminal, openConnectionEditor, lock])

  const submitPassword = useCallback(
    async (password: string): Promise<void> => {
      setLockBusy(true)
      setLockError(null)
      try {
        const status =
          lockPrompt === 'create'
            ? await window.termterm.vaultCreate(password)
            : await window.termterm.vaultUnlock(password)
        const connections = await window.termterm.listConnections()
        useAppStore.getState().setVault(status, connections)
        setLockPrompt('closed')
      } catch (error) {
        setLockError(messageOf(error))
      } finally {
        setLockBusy(false)
      }
    },
    [lockPrompt]
  )

  const deleteConnection = useCallback(async (connection: SavedConnection): Promise<void> => {
    const confirmed = window.confirm(`Delete the saved connection "${connection.name}"?`)
    if (!confirmed) return
    try {
      const connections = await window.termterm.deleteConnection(connection.id)
      useAppStore.getState().setConnections(connections)
      useAppStore.getState().removeNodesForConnection(connection.id)
      useAppStore.getState().setVault(useAppStore.getState().vault, connections)
    } catch (error) {
      console.error('Failed to delete connection', error)
    }
  }, [])

  return (
    <div className="app">
      <TitleBar
        onNewTerminal={() => requestNewTerminal()}
        vault={vault}
        onLock={() => void lock()}
        onUnlock={() => setLockPrompt('unlock')}
        onHelp={() => setHelpOpen(true)}
        onKanban={() => setKanbanOpen(true)}
      />
      <div className="app-body">
        <Sidebar
          onNewTerminal={() => requestNewTerminal()}
          onEditConnection={openConnectionEditor}
          onDeleteConnection={(connection) => void deleteConnection(connection)}
          onRequestUnlock={() => setLockPrompt('unlock')}
        />
        <Canvas openMenu={setMenu} requestNewTerminal={requestNewTerminal} />
      </div>

      <ProfilePicker
        open={pickerOpen}
        profiles={profiles}
        connections={connections}
        onClose={closePicker}
        onSelect={(target) => {
          useAppStore.getState().addNode(target, pickerWorld)
          setPickerWorld(undefined)
        }}
      />

      {editorOpen ? (
        <ConnectionEditor
          open={editorOpen}
          connection={editorConnection}
          x11={x11}
          onClose={() => setEditorOpen(false)}
          onSaved={(connections) => useAppStore.getState().setVault(useAppStore.getState().vault, connections)}
          onDeleted={(connections, id) => {
            useAppStore.getState().setVault(useAppStore.getState().vault, connections)
            useAppStore.getState().removeNodesForConnection(id)
          }}
        />
      ) : null}

      {lockPrompt !== 'closed' ? (
        <LockScreen
          mode={lockPrompt}
          busy={lockBusy}
          error={lockError}
          onSubmit={(password) => void submitPassword(password)}
          onSkip={() => {
            setLockError(null)
            setLockPrompt('closed')
          }}
        />
      ) : null}

      {menu ? <ContextMenu menu={menu} onClose={() => setMenu(null)} /> : null}
      <CloseNodeDialog />

      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
      {kanbanOpen ? <KanbanView onClose={() => setKanbanOpen(false)} /> : null}

      {lastRemoved ? (
        <div className="undo-toast" role="status">
          <span>{lastRemoved.node.title} closed</span>
          <button type="button" onClick={() => useAppStore.getState().undoRemoveNode()}>Undo</button>
        </div>
      ) : null}

      {!ready ? (
        <div className="boot">
          <span>Detecting available shells…</span>
        </div>
      ) : null}
    </div>
  )
}
