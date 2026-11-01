import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { TerminalNodeModel } from '@shared/types'
import { isLayerVisible, useAppStore } from '@/state/useAppStore'
import { centerOnNode, MAX_ZOOM, MIN_ZOOM, nodesBounds, screenToWorld } from '@/lib/canvasMath'
import { NoteNode } from './NoteNode'
import { EditorNode } from './EditorNode'
import { TerminalNode } from './TerminalNode'
import type { ContextMenuState } from './ContextMenu'
import { CloseIcon, FitIcon, MinusIcon, PlusIcon, TargetIcon } from './icons'

interface Props {
  openMenu: (menu: ContextMenuState) => void
  requestNewTerminal: (world?: { x: number; y: number }) => void
}

interface DraftLink {
  from: string
  x: number
  y: number
}

/** Curved edge between two nodes, routed between facing sides. */
function linkPath(a: TerminalNodeModel, b: TerminalNodeModel): string {
  const aCenter = { x: a.x + a.w / 2, y: a.y + a.h / 2 }
  const bCenter = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
  const goingRight = bCenter.x >= aCenter.x
  const start = { x: goingRight ? a.x + a.w : a.x, y: aCenter.y }
  const end = { x: goingRight ? b.x : b.x + b.w, y: bCenter.y }
  const bulge = Math.max(60, Math.abs(end.x - start.x) * 0.4)
  const c1 = { x: start.x + (goingRight ? bulge : -bulge), y: start.y }
  const c2 = { x: end.x + (goingRight ? -bulge : bulge), y: end.y }
  return `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`
}

function draftPath(from: TerminalNodeModel, point: { x: number; y: number }): string {
  const center = { x: from.x + from.w / 2, y: from.y + from.h / 2 }
  const goingRight = point.x >= center.x
  const start = { x: goingRight ? from.x + from.w : from.x, y: center.y }
  const bulge = Math.max(50, Math.abs(point.x - start.x) * 0.45)
  const c1 = { x: start.x + (goingRight ? bulge : -bulge), y: start.y }
  const c2 = { x: point.x + (goingRight ? -bulge : bulge), y: point.y }
  return `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${point.x} ${point.y}`
}

export function Canvas({ openMenu, requestNewTerminal }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const camera = useAppStore((state) => state.camera)
  const nodes = useAppStore((state) => state.nodes)
  const layers = useAppStore((state) => state.layers)
  const links = useAppStore((state) => state.links)
  const profiles = useAppStore((state) => state.profiles)
  const connections = useAppStore((state) => state.connections)
  const selectedId = useAppStore((state) => state.selectedId)
  const stack = useAppStore((state) => state.stack)
  const pendingCenter = useAppStore((state) => state.pendingCenter)
  const viewport = useAppStore((state) => state.viewport)
  const setViewport = useAppStore((state) => state.setViewport)
  const setCamera = useAppStore((state) => state.setCamera)
  const clearPendingCenter = useAppStore((state) => state.clearPendingCenter)
  const addNote = useAppStore((state) => state.addNote)
  const removeLink = useAppStore((state) => state.removeLink)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [draftLink, setDraftLink] = useState<DraftLink | null>(null)
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null)

  const visibleNodes = useMemo(
    () => nodes.filter((node) => isLayerVisible(layers, node.layerId)),
    [nodes, layers]
  )
  const nodesById = useMemo(() => new Map(visibleNodes.map((node) => [node.id, node])), [visibleNodes])
  const visibleLinks = useMemo(
    () => links.filter((link) => nodesById.has(link.from) && nodesById.has(link.to)),
    [links, nodesById]
  )
  const minimapBounds = useMemo(() => nodesBounds(visibleNodes), [visibleNodes])

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      setViewport({ w: element.clientWidth, h: element.clientHeight })
    })
    observer.observe(element)
    setViewport({ w: element.clientWidth, h: element.clientHeight })
    return () => observer.disconnect()
  }, [setViewport])

  useEffect(() => {
    if (!pendingCenter || viewport.w === 0 || nodes.length === 0) return
    setCamera(centerOnNode(nodes[0], viewport, 1))
    clearPendingCenter()
  }, [pendingCenter, viewport, nodes, setCamera, clearPendingCenter])

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const onWheel = (event: WheelEvent): void => {
      const overTerminal = Boolean((event.target as HTMLElement | null)?.closest?.('.terminal-host'))
      const zoomGesture = event.ctrlKey || event.metaKey
      // Plain wheel over a terminal belongs to xterm's own scrollback.
      if (overTerminal && !zoomGesture) return
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      const state = useAppStore.getState()
      if (zoomGesture) {
        const factor = Math.exp(-event.deltaY * 0.0018)
        state.zoomAt(state.camera.zoom * factor, event.clientX - rect.left, event.clientY - rect.top)
        return
      }
      state.panBy(-event.deltaX, -event.deltaY)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code === 'Space') setSpaceHeld(true)
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code === 'Space') setSpaceHeld(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  const startLink = (nodeId: string, event: React.PointerEvent): void => {
    event.stopPropagation()
    event.preventDefault()
    const element = containerRef.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const toWorld = (clientX: number, clientY: number): { x: number; y: number } =>
      screenToWorld(useAppStore.getState().camera, clientX - rect.left, clientY - rect.top)

    setDraftLink({ from: nodeId, ...toWorld(event.clientX, event.clientY) })

    const onMove = (moveEvent: PointerEvent): void => {
      setDraftLink({ from: nodeId, ...toWorld(moveEvent.clientX, moveEvent.clientY) })
    }
    const onUp = (upEvent: PointerEvent): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const target = (document.elementFromPoint(upEvent.clientX, upEvent.clientY) as HTMLElement | null)?.closest(
        '[data-node-id]'
      ) as HTMLElement | null
      const targetId = target?.dataset.nodeId
      if (targetId && targetId !== nodeId) useAppStore.getState().addLink(nodeId, targetId)
      setDraftLink(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const beginPan = (event: React.PointerEvent<HTMLDivElement>): void => {
    const isBackground = !(event.target as HTMLElement).closest('.node, .link-layer')
    if (event.button === 0 && !isBackground && !spaceHeld) return
    if (event.button !== 0 && event.button !== 1) return
    if (isBackground && event.button === 0 && !spaceHeld) {
      useAppStore.getState().selectNode(null)
      setSelectedLinkId(null)
    }
    const element = containerRef.current
    if (!element) return
    event.preventDefault()
    const startX = event.clientX
    const startY = event.clientY
    let last = { x: startX, y: startY }

    const onMove = (moveEvent: PointerEvent): void => {
      const dx = moveEvent.clientX - last.x
      const dy = moveEvent.clientY - last.y
      last = { x: moveEvent.clientX, y: moveEvent.clientY }
      useAppStore.getState().panBy(dx, dy)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.classList.remove('is-panning')
    }
    document.body.classList.add('is-panning')
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const zoomStep = (direction: 1 | -1): void => {
    const state = useAppStore.getState()
    const target = state.camera.zoom * (direction === 1 ? 1.2 : 1 / 1.2)
    state.zoomAt(target, state.viewport.w / 2, state.viewport.h / 2)
  }

  const openCanvasMenu = (event: React.MouseEvent): void => {
    event.preventDefault()
    const rect = containerRef.current?.getBoundingClientRect()
    const world = rect
      ? screenToWorld(useAppStore.getState().camera, event.clientX - rect.left, event.clientY - rect.top)
      : undefined
    openMenu({
      x: event.clientX,
      y: event.clientY,
      entries: [
        { label: 'New terminal…', shortcut: 'Ctrl+T', onSelect: () => requestNewTerminal(world) },
        { label: 'New note', shortcut: 'Ctrl+Shift+N', onSelect: () => addNote(world) },
        'separator',
        { label: 'Fit all terminals', shortcut: 'Ctrl+1', onSelect: () => useAppStore.getState().fitAll() },
        { label: 'Reset zoom to 100%', shortcut: 'Ctrl+0', onSelect: () => useAppStore.getState().resetZoom() }
      ]
    })
  }

  const selectedLink = selectedLinkId ? visibleLinks.find((link) => link.id === selectedLinkId) : undefined
  const selectedLinkMidpoint = (() => {
    if (!selectedLink) return null
    const from = nodesById.get(selectedLink.from)
    const to = nodesById.get(selectedLink.to)
    if (!from || !to) return null
    return {
      x: camera.x + ((from.x + from.w / 2 + to.x + to.w / 2) / 2) * camera.zoom,
      y: camera.y + ((from.y + from.h / 2 + to.y + to.h / 2) / 2) * camera.zoom
    }
  })()

  const draftFrom = draftLink ? nodesById.get(draftLink.from) : undefined

  const surfaceStyle = {
    '--cam-x': camera.x,
    '--cam-y': camera.y,
    '--zoom': camera.zoom
  } as CSSProperties

  return (
    <div
      className={`canvas${spaceHeld ? ' space-held' : ''}`}
      ref={containerRef}
      style={surfaceStyle}
      onPointerDown={beginPan}
      onContextMenu={openCanvasMenu}
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest('.node')) return
        const rect = containerRef.current?.getBoundingClientRect()
        const world = rect
          ? screenToWorld(useAppStore.getState().camera, event.clientX - rect.left, event.clientY - rect.top)
          : undefined
        requestNewTerminal(world)
      }}
    >
      <div className="canvas-grid" />
      <div className="canvas-grid-major" />

      <svg className="link-layer" aria-hidden="true">
        <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.zoom})`}>
          {visibleLinks.map((link) => {
            const from = nodesById.get(link.from)
            const to = nodesById.get(link.to)
            if (!from || !to) return null
            return (
              <g key={link.id}>
                <path
                  d={linkPath(from, to)}
                  className="node-link-hit"
                  vectorEffect="non-scaling-stroke"
                  onPointerDown={(event) => {
                    event.stopPropagation()
                    setSelectedLinkId(link.id)
                  }}
                />
                <path
                  d={linkPath(from, to)}
                  className={`node-link${link.id === selectedLinkId ? ' selected' : ''}`}
                  vectorEffect="non-scaling-stroke"
                  onPointerDown={(event) => {
                    event.stopPropagation()
                    setSelectedLinkId(link.id)
                  }}
                />
              </g>
            )
          })}
          {draftLink && draftFrom ? (
            <path d={draftPath(draftFrom, draftLink)} className="node-link draft" vectorEffect="non-scaling-stroke" />
          ) : null}
        </g>
      </svg>

      {nodes.length === 0 ? (
        <div className="canvas-empty">
          <h2>Your canvas is empty</h2>
          <p>
            Double-click anywhere, or press <kbd>Ctrl</kbd> + <kbd>T</kbd>, to place a terminal.
          </p>
        </div>
      ) : null}

      {nodes.length > 0 && visibleNodes.length === 0 ? (
        <div className="canvas-empty">
          <h2>All layers are hidden</h2>
          <p>Turn a layer back on in the sidebar to bring its terminals back.</p>
        </div>
      ) : null}

      {visibleNodes.map((node) => {
        const isNote = node.kind === 'note'
        const linkedTargets = isNote
            ? links
                .filter((link) => link.from === node.id || link.to === node.id)
                .map((link) => nodesById.get(link.from === node.id ? link.to : link.from))
                .filter((target): target is TerminalNodeModel => Boolean(target) && target?.kind !== 'note')
                .map((target) => {
                  const connection = connections.find((entry) => entry.id === target.connectionId)
                  return { id: target.id, title: target.titleCustom ? target.title : (connection?.name ?? target.title) }
                })
            : []

        if (isNote) {
          return (
            <NoteNode
              key={node.id}
              node={node}
              selected={node.id === selectedId}
              zIndex={stack.indexOf(node.id) + 1}
              linkedTargets={linkedTargets}
              onStartLink={startLink}
              onSendTo={(targetId, text) => window.termterm.write(targetId, text)}
            />
          )
        }

        if (node.kind === 'editor' || node.kind === 'diff') {
          return (
            <EditorNode
              key={node.id}
              node={node}
              selected={node.id === selectedId}
              zIndex={stack.indexOf(node.id) + 1}
            />
          )
        }

        if (node.kind !== 'terminal' && node.kind !== undefined) return null

        return (
          <TerminalNode
            key={node.id}
            node={node}
            zoom={camera.zoom}
            selected={node.id === selectedId}
            zIndex={stack.indexOf(node.id) + 1}
            profile={profiles.find((profile) => profile.id === node.profileId)}
            connection={connections.find((connection) => connection.id === node.connectionId)}
            openMenu={openMenu}
            onStartLink={startLink}
          />
        )
      })}

      {selectedLinkMidpoint ? (
        <button
          type="button"
          className="link-remove"
          style={{ left: selectedLinkMidpoint.x, top: selectedLinkMidpoint.y }}
          title="Remove link"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            if (selectedLinkId) removeLink(selectedLinkId)
            setSelectedLinkId(null)
          }}
        >
          <CloseIcon size={11} />
        </button>
      ) : null}

      <div
        className="zoom-controls"
        onPointerDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
      >
        <button type="button" className="icon-button" title="Zoom out" onClick={() => zoomStep(-1)}>
          <MinusIcon size={14} />
        </button>
        <button
          type="button"
          className="zoom-value"
          title="Reset zoom to 100%"
          onClick={() => useAppStore.getState().resetZoom()}
        >
          {Math.round(camera.zoom * 100)}%
        </button>
        <button type="button" className="icon-button" title="Zoom in" onClick={() => zoomStep(1)}>
          <PlusIcon size={14} />
        </button>
        <span className="zoom-divider" />
        <button type="button" className="icon-button" title="Fit all terminals (Ctrl+1)" onClick={() => useAppStore.getState().fitAll()}>
          <FitIcon size={14} />
        </button>
        <button type="button" className="icon-button" title="Centre view" onClick={() => useAppStore.getState().resetZoom()}>
          <TargetIcon size={14} />
        </button>
      </div>

      {minimapBounds ? (
        <button
          type="button"
          className="canvas-minimap"
          title="Navigate canvas"
          aria-label="Canvas minimap. Click to move the view."
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            const x = (event.clientX - rect.left) / rect.width
            const y = (event.clientY - rect.top) / rect.height
            const worldX = minimapBounds.x + minimapBounds.w * x
            const worldY = minimapBounds.y + minimapBounds.h * y
            setCamera({
              ...camera,
              x: viewport.w / 2 - worldX * camera.zoom,
              y: viewport.h / 2 - worldY * camera.zoom
            })
          }}
        >
          <svg viewBox={`${minimapBounds.x} ${minimapBounds.y} ${minimapBounds.w} ${minimapBounds.h}`} aria-hidden="true">
            {visibleNodes.map((node) => (
              <rect
                key={node.id}
                className={node.id === selectedId ? 'minimap-node selected' : 'minimap-node'}
                x={node.x}
                y={node.y}
                width={node.w}
                height={node.h}
                rx={24}
              />
            ))}
            <rect
              className="minimap-viewport"
              x={-camera.x / camera.zoom}
              y={-camera.y / camera.zoom}
              width={viewport.w / camera.zoom}
              height={viewport.h / camera.zoom}
              rx={24}
            />
          </svg>
        </button>
      ) : null}

      <div className="canvas-hint">
        <span>
          {Math.round(MIN_ZOOM * 100)}–{Math.round(MAX_ZOOM * 100)}% zoom
        </span>
        <span className="dot" />
        <span>Drag to pan · Ctrl+wheel to zoom · Drag a node port to link</span>
      </div>
    </div>
  )
}
