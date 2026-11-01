import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Layer, SavedConnection } from '@shared/types'
import {
  describeLayerDeletion,
  isLayerVisible,
  useAppStore,
  type LayerDeletionSummary
} from '@/state/useAppStore'
import { ProfileBadge } from './ProfileBadge'
import { ConfirmDialog } from './ConfirmDialog'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  EyeIcon,
  EyeOffIcon,
  LockIcon,
  PencilIcon,
  PlusIcon,
  TerminalIcon,
  TrashIcon
} from './icons'

interface Props {
  onNewTerminal: () => void
  onEditConnection: (connection: SavedConnection | null) => void
  onDeleteConnection: (connection: SavedConnection) => void
  onRequestUnlock: () => void
}

export function Sidebar({ onNewTerminal, onEditConnection, onDeleteConnection, onRequestUnlock }: Props) {
  const [collapsed, setCollapsed] = useState(false)
  const [renamingLayer, setRenamingLayer] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null)
  const [dropLayerId, setDropLayerId] = useState<string | null>(null)
  const [pendingLayerDelete, setPendingLayerDelete] = useState<{
    layer: Layer
    summary: LayerDeletionSummary
  } | null>(null)

  const nodes = useAppStore((state) => state.nodes)
  const layers = useAppStore((state) => state.layers)
  const profiles = useAppStore((state) => state.profiles)
  const connections = useAppStore((state) => state.connections)
  const vault = useAppStore((state) => state.vault)
  const vaultLocked = useAppStore((state) => state.vaultLocked)
  const selectedId = useAppStore((state) => state.selectedId)
  const statuses = useAppStore((state) => state.statuses)

  const focusNode = useAppStore((state) => state.focusNode)
  const requestCloseNode = useAppStore((state) => state.requestCloseNode)
  const addNode = useAppStore((state) => state.addNode)
  const addLayer = useAppStore((state) => state.addLayer)
  const renameLayer = useAppStore((state) => state.renameLayer)
  const deleteLayer = useAppStore((state) => state.deleteLayer)
  const toggleLayerVisible = useAppStore((state) => state.toggleLayerVisible)
  const toggleLayerCollapsed = useAppStore((state) => state.toggleLayerCollapsed)
  const moveNodeToLayer = useAppStore((state) => state.moveNodeToLayer)

  const childrenOf = useMemo(() => {
    const map = new Map<string | null, Layer[]>()
    for (const layer of layers) {
      const list = map.get(layer.parentId) ?? []
      list.push(layer)
      map.set(layer.parentId, list)
    }
    return map
  }, [layers])

  const nodesByLayer = useMemo(() => {
    const map = new Map<string, typeof nodes>()
    for (const node of nodes) {
      const list = map.get(node.layerId) ?? []
      list.push(node)
      map.set(node.layerId, list)
    }
    return map
  }, [nodes])

  if (collapsed) {
    return (
      <aside className="sidebar collapsed">
        <button type="button" className="icon-button" title="Show terminals" onClick={() => setCollapsed(false)}>
          <TerminalIcon size={16} />
        </button>
        <button type="button" className="icon-button" title="New terminal" onClick={onNewTerminal}>
          <PlusIcon size={16} />
        </button>
        <span className="sidebar-count">{nodes.length}</span>
      </aside>
    )
  }

  const commitRename = (): void => {
    if (renamingLayer) renameLayer(renamingLayer, draftName)
    setRenamingLayer(null)
  }

  const requestDeleteLayer = (layer: Layer): void => {
    const summary = describeLayerDeletion(layers, nodes, layer.id)
    // An empty layer can go without ceremony.
    if (summary.nodeCount === 0 && summary.sublayerCount === 0) {
      deleteLayer(layer.id, 'purge')
      return
    }
    setPendingLayerDelete({ layer, summary })
  }

  /** Pointer-based drag: HTML5 drag-and-drop is unreliable inside Electron. */
  const beginNodeDrag = (event: React.PointerEvent<HTMLDivElement>, nodeId: string): void => {
    if (event.button !== 0) return
    const startX = event.clientX
    const startY = event.clientY
    let dragging = false

    const layerUnder = (x: number, y: number): string | null => {
      const element = document.elementFromPoint(x, y)?.closest('[data-layer-id]') as HTMLElement | null
      return element?.dataset.layerId ?? null
    }

    const onMove = (moveEvent: PointerEvent): void => {
      if (!dragging && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 6) return
      dragging = true
      setDraggingNodeId(nodeId)
      setDropLayerId(layerUnder(moveEvent.clientX, moveEvent.clientY))
    }
    const onUp = (upEvent: PointerEvent): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (dragging) {
        const layerId = layerUnder(upEvent.clientX, upEvent.clientY)
        if (layerId) moveNodeToLayer(nodeId, layerId)
      }
      setDraggingNodeId(null)
      setDropLayerId(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const renderLayer = (layer: Layer, depth: number): ReactNode => {
    const childLayers = childrenOf.get(layer.id) ?? []
    const ownNodes = nodesByLayer.get(layer.id) ?? []
    const hasChildren = childLayers.length > 0 || ownNodes.length > 0
    const visible = isLayerVisible(layers, layer.id)

    return (
      <div key={layer.id} className="layer-block">
        <div
          className={`layer-row${visible ? '' : ' hidden-layer'}${dropLayerId === layer.id ? ' drop-target' : ''}`}
          style={{ paddingLeft: 4 + depth * 12 }}
          data-layer-id={layer.id}
          onDoubleClick={() => {
            setRenamingLayer(layer.id)
            setDraftName(layer.name)
          }}
        >
          <button
            type="button"
            className="icon-button tiny"
            title={layer.collapsed ? 'Expand' : 'Collapse'}
            onClick={() => toggleLayerCollapsed(layer.id)}
            disabled={!hasChildren}
          >
            {layer.collapsed ? <ChevronRightIcon size={13} /> : <ChevronLeftIcon size={13} />}
          </button>

          {renamingLayer === layer.id ? (
            <input
              className="layer-name-input"
              value={draftName}
              autoFocus
              onChange={(event) => setDraftName(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitRename()
                if (event.key === 'Escape') setRenamingLayer(null)
              }}
            />
          ) : (
            <span className="layer-name" title={`${layer.name} – drop terminals here to move them`}>
              {layer.name}
            </span>
          )}

          <span className="layer-count">{ownNodes.length}</span>

          <button
            type="button"
            className="icon-button tiny"
            title={visible ? 'Hide this layer' : 'Show this layer'}
            onClick={() => toggleLayerVisible(layer.id)}
          >
            {visible ? <EyeIcon size={13} /> : <EyeOffIcon size={13} />}
          </button>
          <button
            type="button"
            className="icon-button tiny hover-only"
            title="New sublayer"
            onClick={() => addLayer(layer.id)}
          >
            <PlusIcon size={13} />
          </button>
          <button
            type="button"
            className="icon-button tiny hover-only"
            title="Delete layer"
            onClick={() => requestDeleteLayer(layer)}
            disabled={layers.length <= 1}
          >
            <TrashIcon size={13} />
          </button>
        </div>

        {!layer.collapsed ? (
          <>
            {childLayers.map((child) => renderLayer(child, depth + 1))}
            {ownNodes.map((node) => {
              const profile = profiles.find((candidate) => candidate.id === node.profileId)
              const connection = connections.find((candidate) => candidate.id === node.connectionId)
              const status = statuses[node.id] ?? 'starting'
              const isNote = node.kind === 'note'
              const badge = isNote
                ? { badge: 'N', accent: node.color ?? '#f5c451' }
                : (profile ?? connection)
              const displayTitle = isNote
                ? node.text?.trim().split('\n')[0]?.slice(0, 42) || 'Empty note'
                : node.titleCustom
                  ? node.title
                  : (connection?.name ?? node.title)
              const meta = isNote
                ? 'note'
                : connection
                  ? `${connection.kind}://${connection.host}`
                  : node.cwd || profile?.kind || 'shell'
              return (
                <div
                  key={node.id}
                  className={`sidebar-item nested${node.id === selectedId ? ' selected' : ''}${
                    visible ? '' : ' dimmed'
                  }${draggingNodeId === node.id ? ' dragging' : ''}`}
                  style={{ marginLeft: 12 + depth * 12 }}
                  onClick={() => focusNode(node.id)}
                  onPointerDown={(event) => beginNodeDrag(event, node.id)}
                  title="Drag onto a layer to move this terminal"
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') focusNode(node.id)
                  }}
                >
                  <ProfileBadge profile={badge} size={18} />
                  <span className="sidebar-item-text">
                    <span className="sidebar-item-name">{displayTitle}</span>
                    <span className="sidebar-item-meta">{meta}</span>
                  </span>
                  {isNote ? null : (
                    <span
                      className={`node-status ${status}`}
                      role="status"
                      aria-label={`Session ${status}`}
                      title={`Session: ${status}`}
                    />
                  )}
                  <button
                    type="button"
                    className="icon-button subtle"
                    title={isNote ? 'Delete note' : 'Close terminal'}
                    onClick={(event) => {
                      event.stopPropagation()
                      requestCloseNode(node.id)
                    }}
                  >
                    <CloseIcon size={12} />
                  </button>
                </div>
              )
            })}
          </>
        ) : null}
      </div>
    )
  }

  const roots = childrenOf.get(null) ?? []
  const locked = vault.exists && vaultLocked

  const pendingDelete = pendingLayerDelete
    ? {
        layer: pendingLayerDelete.layer,
        summary: pendingLayerDelete.summary,
        items: `${pendingLayerDelete.summary.nodeCount} item${pendingLayerDelete.summary.nodeCount === 1 ? '' : 's'}`,
        extraLayers:
          pendingLayerDelete.summary.sublayerCount > 0
            ? ` and ${pendingLayerDelete.summary.sublayerCount} sublayer${
                pendingLayerDelete.summary.sublayerCount === 1 ? '' : 's'
              }`
            : ''
      }
    : null

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Workspace</span>
        <span className="sidebar-count">{nodes.length}</span>
        <button type="button" className="icon-button" title="Collapse sidebar" onClick={() => setCollapsed(true)}>
          <ChevronLeftIcon size={16} />
        </button>
      </div>

      <button type="button" className="sidebar-new" onClick={onNewTerminal}>
        <PlusIcon size={15} />
        <span>New terminal</span>
        <kbd>Ctrl T</kbd>
      </button>

      <div className="sidebar-scroll">
        {nodes.length > 0 ? (
          <section className="sidebar-section">
            <header className="sidebar-section-header"><span>Recents</span></header>
            {[...nodes].reverse().slice(0, 5).map((node) => {
              const connection = connections.find((candidate) => candidate.id === node.connectionId)
              const profile = profiles.find((candidate) => candidate.id === node.profileId)
              const title = node.kind === 'note'
                ? node.text?.trim().split('\n')[0]?.slice(0, 42) || 'Empty note'
                : node.titleCustom ? node.title : (connection?.name ?? profile?.name ?? node.title)
              return (
                <button key={node.id} type="button" className="recent-session" onClick={() => focusNode(node.id)}>
                  <span>{title}</span>
                  <span>{node.kind === 'note' ? 'note' : statuses[node.id] ?? 'starting'}</span>
                </button>
              )
            })}
          </section>
        ) : null}
        <section className="sidebar-section">
          <header className="sidebar-section-header">
            <span>Layers</span>
            <span className="spacer" />
            <button type="button" className="icon-button tiny" title="New layer" onClick={() => addLayer(null)}>
              <PlusIcon size={13} />
            </button>
          </header>
          <div className="layer-tree">{roots.map((layer) => renderLayer(layer, 0))}</div>
          {nodes.length === 0 ? <p className="sidebar-empty">No terminals yet.</p> : null}
        </section>

        <section className="sidebar-section">
          <header className="sidebar-section-header">
            <span>Connections</span>
            {vault.unlocked ? <span className="section-badge">{connections.length}</span> : null}
            <span className="spacer" />
            <button
              type="button"
              className="icon-button tiny"
              title={locked ? 'Unlock the vault to add connections' : 'New saved connection'}
              onClick={() => (locked ? onRequestUnlock() : onEditConnection(null))}
            >
              <PlusIcon size={13} />
            </button>
          </header>

          {locked ? (
            <button type="button" className="vault-locked" onClick={onRequestUnlock}>
              <LockIcon size={14} />
              <span>Vault locked – unlock to load saved connections</span>
            </button>
          ) : (
            <div className="connection-list">
              {connections.length === 0 ? (
                <p className="sidebar-empty">
                  {vault.unlocked
                    ? 'No saved connections yet. Add SSH, Telnet or RDP targets here.'
                    : 'Set a master password to save SSH, Telnet and RDP targets.'}
                </p>
              ) : null}
              {connections.map((connection) => (
                <div
                  key={connection.id}
                  className="sidebar-item connection-row"
                  onClick={() => {
                    const id = addNode({ connectionId: connection.id })
                    if (id) focusNode(id)
                  }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      const id = addNode({ connectionId: connection.id })
                      if (id) focusNode(id)
                    }
                  }}
                >
                  <ProfileBadge profile={connection} size={18} />
                  <span className="sidebar-item-text">
                    <span className="sidebar-item-name">{connection.name}</span>
                    <span className="sidebar-item-meta">
                      {connection.kind}://{connection.host}
                      {connection.port ? `:${connection.port}` : ''}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="icon-button subtle"
                    title="Edit connection"
                    onClick={(event) => {
                      event.stopPropagation()
                      onEditConnection(connection)
                    }}
                  >
                    <PencilIcon size={12} />
                  </button>
                  <button
                    type="button"
                    className="icon-button subtle"
                    title="Delete connection"
                    onClick={(event) => {
                      event.stopPropagation()
                      onDeleteConnection(connection)
                    }}
                  >
                    <TrashIcon size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <footer className="sidebar-footer">
        <span>{profiles.length} shells</span>
        <span className="dot" />
        <span>{vault.exists ? (vault.unlocked ? 'vault unlocked' : 'vault locked') : 'no vault'}</span>
      </footer>

      {pendingDelete ? (
        <ConfirmDialog
          open
          title={`Delete layer “${pendingDelete.layer.name}”?`}
          body={
            <>
              <p>
                This layer holds {pendingDelete.items}
                {pendingDelete.extraLayers}.
              </p>
              <p className="confirm-note">Nothing is removed until you choose.</p>
            </>
          }
          choices={[
            {
              label: 'Keep them',
              hint:
                pendingDelete.summary.sublayerCount > 0
                  ? `Sublayers move up one level, terminals go to “${pendingDelete.summary.fallbackLayerName}”`
                  : `Move ${pendingDelete.items} into “${pendingDelete.summary.fallbackLayerName}”`,
              tone: 'primary',
              onSelect: () => deleteLayer(pendingDelete.layer.id, 'keep')
            },
            {
              label: 'Delete everything',
              hint: `Close ${pendingDelete.items}${pendingDelete.extraLayers} for good`,
              tone: 'danger',
              onSelect: () => deleteLayer(pendingDelete.layer.id, 'purge')
            }
          ]}
          onClose={() => setPendingLayerDelete(null)}
        />
      ) : null}
    </aside>
  )
}
