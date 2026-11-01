import { create } from 'zustand'
import type {
  Camera,
  Layer,
  NodeLink,
  PersistedLayout,
  SavedConnection,
  ShellProfile,
  TerminalNodeModel,
  VaultStatus
} from '@shared/types'
import { cascadePosition, centerOnNode, clampZoom, fitCamera, type Size } from '@/lib/canvasMath'

const DEFAULT_LAYER_ID = 'layer-workspace'
const DEFAULT_NODE_SIZE = { w: 720, h: 440 }
const MIN_NODE_SIZE = { w: 280, h: 180 }

export type SessionStatus = 'starting' | 'connecting' | 'running' | 'exited' | 'error'

export type NodeTarget = { profileId: string } | { connectionId: string }

interface AppState {
  ready: boolean
  nodes: TerminalNodeModel[]
  layers: Layer[]
  links: NodeLink[]
  /** Paint order (last on top). Kept separate from `nodes` so DOM nodes never move. */
  stack: string[]
  camera: Camera
  viewport: Size
  profiles: ShellProfile[]
  connections: SavedConnection[]
  vault: VaultStatus
  /** True when a vault exists but is not unlocked: saved connections are unavailable. */
  vaultLocked: boolean
  selectedId: string | null
  statuses: Record<string, SessionStatus>
  pendingCenter: boolean
  lastRemoved: { node: TerminalNodeModel; links: NodeLink[]; stackIndex: number } | null
  /** Node awaiting a close confirmation; every close entry point sets this. */
  closeRequestId: string | null

  hydrate: (layout: PersistedLayout | null, profiles: ShellProfile[], vault: VaultStatus) => void
  setProfiles: (profiles: ShellProfile[]) => void
  setVault: (vault: VaultStatus, connections: SavedConnection[]) => void
  lockVaultState: (vault: VaultStatus) => void
  setConnections: (connections: SavedConnection[]) => void
  removeNodesForConnection: (connectionId: string) => void

  setViewport: (viewport: Size) => void
  setCamera: (camera: Camera) => void
  panBy: (dx: number, dy: number) => void
  zoomAt: (nextZoom: number, screenX: number, screenY: number) => void
  resetZoom: () => void
  fitAll: () => void
  focusNode: (nodeId: string) => void

  addNode: (target: NodeTarget, position?: { x: number; y: number }, layerId?: string) => string | null
  addNote: (position?: { x: number; y: number }, layerId?: string) => string
  addEditor: (kind?: 'editor' | 'diff', position?: { x: number; y: number }, layerId?: string) => string
  updateNode: (nodeId: string, patch: Partial<TerminalNodeModel>) => void
  requestCloseNode: (nodeId: string) => void
  cancelCloseNode: () => void
  removeNode: (nodeId: string) => void
  undoRemoveNode: () => void
  setStatus: (nodeId: string, status: SessionStatus) => void
  selectNode: (nodeId: string | null) => void
  bringToFront: (nodeId: string) => void
  clearPendingCenter: () => void

  addLayer: (parentId?: string | null) => string
  renameLayer: (layerId: string, name: string) => void
  toggleLayerVisible: (layerId: string) => void
  toggleLayerCollapsed: (layerId: string) => void
  deleteLayer: (layerId: string, mode: 'keep' | 'purge') => void
  moveNodeToLayer: (nodeId: string, layerId: string) => void

  addLink: (from: string, to: string) => void
  removeLink: (linkId: string) => void
}

function uniqueTitle(existing: string[], base: string): string {
  const used = new Set(existing)
  if (!used.has(base)) return base
  let index = 2
  while (used.has(`${base} ${index}`)) index += 1
  return `${base} ${index}`
}

/** A layer is visible only when it and every ancestor is visible. */
export function isLayerVisible(layers: Layer[], layerId: string): boolean {
  const byId = new Map(layers.map((layer) => [layer.id, layer]))
  const seen = new Set<string>()
  let cursor: string | null = layerId
  while (cursor) {
    if (seen.has(cursor)) return false
    seen.add(cursor)
    const layer = byId.get(cursor)
    if (!layer) return true
    if (!layer.visible) return false
    cursor = layer.parentId
  }
  return true
}

export function layerDepth(layers: Layer[], layerId: string): number {
  const byId = new Map(layers.map((layer) => [layer.id, layer]))
  const seen = new Set<string>()
  let depth = 0
  let cursor: string | null = byId.get(layerId)?.parentId ?? null
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    depth += 1
    cursor = byId.get(cursor)?.parentId ?? null
  }
  return depth
}

/** A layer plus every layer nested beneath it. */
export function collectLayerSubtree(layers: Layer[], layerId: string): Set<string> {
  const doomed = new Set<string>([layerId])
  let grew = true
  while (grew) {
    grew = false
    for (const layer of layers) {
      if (layer.parentId && doomed.has(layer.parentId) && !doomed.has(layer.id)) {
        doomed.add(layer.id)
        grew = true
      }
    }
  }
  return doomed
}

export interface LayerDeletionSummary {
  /** Nodes directly inside the layer or any of its sublayers. */
  nodeCount: number
  /** Nested layers that would be removed with it. */
  sublayerCount: number
  /** Where items go when the user chooses "keep". */
  fallbackLayerId: string
  fallbackLayerName: string
}

export function describeLayerDeletion(
  layers: Layer[],
  nodes: TerminalNodeModel[],
  layerId: string
): LayerDeletionSummary {
  const target = layers.find((layer) => layer.id === layerId)
  const subtree = collectLayerSubtree(layers, layerId)
  const fallback = target?.parentId ?? layers.find((layer) => !subtree.has(layer.id))?.id ?? layerId
  return {
    nodeCount: nodes.filter((node) => subtree.has(node.layerId)).length,
    sublayerCount: subtree.size - 1,
    fallbackLayerId: fallback,
    fallbackLayerName: layers.find((layer) => layer.id === fallback)?.name ?? 'the layer above'
  }
}

function defaultLayer(): Layer {
  return { id: DEFAULT_LAYER_ID, name: 'Workspace', parentId: null, visible: true, collapsed: false }
}

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  nodes: [],
  layers: [defaultLayer()],
  links: [],
  stack: [],
  camera: { x: 0, y: 0, zoom: 1 },
  viewport: { w: 0, h: 0 },
  profiles: [],
  connections: [],
  vault: { exists: false, unlocked: false, connectionCount: 0 },
  vaultLocked: false,
  selectedId: null,
  statuses: {},
  pendingCenter: false,
  lastRemoved: null,
  closeRequestId: null,

  hydrate: (layout, profiles, vault) => {
    const layers = layout?.layers && layout.layers.length > 0 ? layout.layers : [defaultLayer()]
    const knownLayers = new Set(layers.map((layer) => layer.id))
    const nodes = (layout?.nodes ?? []).map((node) =>
      knownLayers.has(node.layerId) ? node : { ...node, layerId: layers[0].id }
    )

    if (nodes.length > 0) {
      set({
        ready: true,
        nodes,
        layers,
        links: layout?.links ?? [],
        stack: nodes.map((node) => node.id),
        profiles,
        vault,
        vaultLocked: vault.exists && !vault.unlocked,
        camera: layout?.camera ?? { x: 0, y: 0, zoom: 1 },
        selectedId: nodes[nodes.length - 1]?.id ?? null,
        pendingCenter: false
      })
      return
    }

    const preferred =
      profiles.find((profile) => profile.id === 'pwsh7') ??
      profiles.find((profile) => profile.id === 'powershell') ??
      profiles.find((profile) => profile.kind === 'unix') ??
      profiles[0]

    const seeded: TerminalNodeModel[] = preferred
      ? [
          {
            id: crypto.randomUUID(),
            title: uniqueTitle([], preferred.name),
            layerId: layers[0].id,
            profileId: preferred.id,
            x: 0,
            y: 0,
            ...DEFAULT_NODE_SIZE
          }
        ]
      : []

    set({
      ready: true,
      nodes: seeded,
      layers,
      links: layout?.links ?? [],
      stack: seeded.map((node) => node.id),
      profiles,
      vault,
      vaultLocked: vault.exists && !vault.unlocked,
      camera: { x: 0, y: 0, zoom: 1 },
      selectedId: seeded[0]?.id ?? null,
      pendingCenter: seeded.length > 0
    })
  },

  setProfiles: (profiles) => set({ profiles }),

  setVault: (vault, connections) =>
    set({ vault, connections, vaultLocked: vault.exists && !vault.unlocked }),

  lockVaultState: (vault) => set({ vault, connections: [], vaultLocked: true }),

  setConnections: (connections) => set({ connections }),

  removeNodesForConnection: (connectionId) => {
    set((state) => {
      const removed = new Set(
        state.nodes.filter((node) => node.connectionId === connectionId).map((node) => node.id)
      )
      if (removed.size === 0) return state
      const statuses = { ...state.statuses }
      for (const id of removed) delete statuses[id]
      return {
        nodes: state.nodes.filter((node) => !removed.has(node.id)),
        stack: state.stack.filter((id) => !removed.has(id)),
        statuses,
        selectedId: state.selectedId && removed.has(state.selectedId) ? null : state.selectedId
      }
    })
  },

  setViewport: (viewport) => set({ viewport }),

  setCamera: (camera) => set({ camera: { ...camera, zoom: clampZoom(camera.zoom) } }),

  panBy: (dx, dy) => {
    const { camera } = get()
    set({ camera: { ...camera, x: camera.x + dx, y: camera.y + dy } })
  },

  zoomAt: (nextZoom, screenX, screenY) => {
    const { camera } = get()
    const zoom = clampZoom(nextZoom)
    if (zoom === camera.zoom) return
    const worldX = (screenX - camera.x) / camera.zoom
    const worldY = (screenY - camera.y) / camera.zoom
    set({ camera: { zoom, x: screenX - worldX * zoom, y: screenY - worldY * zoom } })
  },

  resetZoom: () => {
    const { camera, viewport } = get()
    const centreX = viewport.w / 2
    const centreY = viewport.h / 2
    const worldX = (centreX - camera.x) / camera.zoom
    const worldY = (centreY - camera.y) / camera.zoom
    set({ camera: { zoom: 1, x: centreX - worldX, y: centreY - worldY } })
  },

  fitAll: () => {
    const { nodes, layers, viewport } = get()
    const visible = nodes.filter((node) => isLayerVisible(layers, node.layerId))
    const camera = fitCamera(visible.length > 0 ? visible : nodes, viewport)
    if (camera) set({ camera })
  },

  focusNode: (nodeId) => {
    const { nodes, viewport, camera } = get()
    const node = nodes.find((candidate) => candidate.id === nodeId)
    if (!node) return
    const zoom = Math.min(1, Math.max(camera.zoom, 0.7))
    set({ camera: centerOnNode(node, viewport, zoom), selectedId: nodeId })
  },

  addNode: (target, position, layerId) => {
    const { nodes, layers, camera, viewport, profiles, connections } = get()
    const isConnection = 'connectionId' in target
    const profile = !isConnection ? profiles.find((entry) => entry.id === target.profileId) : undefined
    const connection = isConnection ? connections.find((entry) => entry.id === target.connectionId) : undefined
    if (!isConnection && !profile) return null
    if (isConnection && !connection) return null

    const spawn = position ?? cascadePosition(nodes, viewport, camera)
    const layer = layerId && layers.some((entry) => entry.id === layerId) ? layerId : (layers[0]?.id ?? DEFAULT_LAYER_ID)
    // Auto titles never contain the hostname: layout.json is not encrypted, the vault is.
    const baseTitle = connection ? `${connection.kind.toUpperCase()} session` : (profile?.name ?? 'Terminal')
    const node: TerminalNodeModel = {
      id: crypto.randomUUID(),
      title: uniqueTitle(
        nodes.map((existing) => existing.title),
        baseTitle
      ),
      layerId: layer,
      ...(isConnection ? { connectionId: target.connectionId } : { profileId: target.profileId }),
      x: Math.round(position ? spawn.x - DEFAULT_NODE_SIZE.w / 2 : spawn.x),
      y: Math.round(position ? spawn.y - DEFAULT_NODE_SIZE.h / 2 : spawn.y),
      ...DEFAULT_NODE_SIZE
    }
    set({ nodes: [...nodes, node], stack: [...get().stack, node.id], selectedId: node.id })
    return node.id
  },

  updateNode: (nodeId, patch) => {
    set((state) => ({
      nodes: state.nodes.map((node) => {
        if (node.id !== nodeId) return node
        const next = { ...node, ...patch }
        if (patch.title !== undefined) next.titleCustom = true
        next.w = Math.max(MIN_NODE_SIZE.w, Math.round(next.w))
        next.h = Math.max(MIN_NODE_SIZE.h, Math.round(next.h))
        next.x = Math.round(next.x)
        next.y = Math.round(next.y)
        return next
      })
    }))
  },

  requestCloseNode: (nodeId) => {
    if (get().nodes.some((node) => node.id === nodeId)) set({ closeRequestId: nodeId })
  },

  cancelCloseNode: () => set({ closeRequestId: null }),

  removeNode: (nodeId) => {
    set((state) => {
      const node = state.nodes.find((candidate) => candidate.id === nodeId)
      if (!node) return state
      const statuses = { ...state.statuses }
      delete statuses[nodeId]
      return {
        nodes: state.nodes.filter((node) => node.id !== nodeId),
        links: state.links.filter((link) => link.from !== nodeId && link.to !== nodeId),
        stack: state.stack.filter((id) => id !== nodeId),
        selectedId: state.selectedId === nodeId ? null : state.selectedId,
        closeRequestId: state.closeRequestId === nodeId ? null : state.closeRequestId,
        statuses,
        lastRemoved: {
          node,
          links: state.links.filter((link) => link.from === nodeId || link.to === nodeId),
          stackIndex: state.stack.indexOf(nodeId)
        }
      }
    })
  },

  undoRemoveNode: () => {
    set((state) => {
      const removed = state.lastRemoved
      if (!removed) return state
      const nodes = [...state.nodes, removed.node].sort((a, b) => {
        const aIndex = state.stack.indexOf(a.id)
        const bIndex = state.stack.indexOf(b.id)
        return aIndex - bIndex
      })
      const stack = [...state.stack]
      stack.splice(Math.max(0, removed.stackIndex), 0, removed.node.id)
      return {
        nodes,
        links: [...state.links, ...removed.links],
        stack,
        selectedId: removed.node.id,
        lastRemoved: null
      }
    })
  },

  setStatus: (nodeId, status) => {
    set((state) =>
      state.statuses[nodeId] === status ? state : { statuses: { ...state.statuses, [nodeId]: status } }
    )
  },

  selectNode: (nodeId) => set({ selectedId: nodeId }),

  bringToFront: (nodeId) => {
    set((state) => {
      if (state.stack[state.stack.length - 1] === nodeId) return state
      return { stack: [...state.stack.filter((id) => id !== nodeId), nodeId] }
    })
  },

  clearPendingCenter: () => set({ pendingCenter: false }),

  addLayer: (parentId) => {
    const { layers } = get()
    const id = `layer-${crypto.randomUUID().slice(0, 8)}`
    const siblings = layers.filter((layer) => layer.parentId === (parentId ?? null))
    const layer: Layer = {
      id,
      name: uniqueTitle(
        siblings.map((entry) => entry.name),
        parentId ? 'New sublayer' : 'New layer'
      ),
      parentId: parentId ?? null,
      visible: true,
      collapsed: false
    }
    set({ layers: [...layers, layer] })
    return id
  },

  renameLayer: (layerId, name) => {
    const trimmed = name.trim().slice(0, 80)
    if (!trimmed) return
    set((state) => ({
      layers: state.layers.map((layer) => (layer.id === layerId ? { ...layer, name: trimmed } : layer))
    }))
  },

  toggleLayerVisible: (layerId) => {
    set((state) => ({
      layers: state.layers.map((layer) =>
        layer.id === layerId ? { ...layer, visible: !layer.visible } : layer
      )
    }))
  },

  toggleLayerCollapsed: (layerId) => {
    set((state) => ({
      layers: state.layers.map((layer) =>
        layer.id === layerId ? { ...layer, collapsed: !layer.collapsed } : layer
      )
    }))
  },

  deleteLayer: (layerId, mode) => {
    set((state) => {
      const target = state.layers.find((layer) => layer.id === layerId)
      if (!target) return state
      const subtree = collectLayerSubtree(state.layers, layerId)

      if (mode === 'keep') {
        const fallback = target.parentId ?? state.layers.find((layer) => !subtree.has(layer.id))?.id ?? layerId
        return {
          // Child layers are promoted one level so nothing is lost.
          layers: state.layers
            .filter((layer) => layer.id !== layerId)
            .map((layer) => (layer.parentId === layerId ? { ...layer, parentId: target.parentId } : layer)),
          // Only nodes directly in this layer move up; promoted sublayers keep theirs.
          nodes: state.nodes.map((node) =>
            node.layerId === layerId ? { ...node, layerId: fallback } : node
          )
        }
      }

      // purge: remove the layer, everything nested under it, and their nodes.
      if (subtree.size >= state.layers.length) {
        // Never leave the canvas without any layer at all.
        return state
      }
      const removedNodeIds = new Set(
        state.nodes.filter((node) => subtree.has(node.layerId)).map((node) => node.id)
      )
      const statuses = { ...state.statuses }
      for (const id of removedNodeIds) delete statuses[id]
      return {
        layers: state.layers.filter((layer) => !subtree.has(layer.id)),
        nodes: state.nodes.filter((node) => !removedNodeIds.has(node.id)),
        links: state.links.filter((link) => !removedNodeIds.has(link.from) && !removedNodeIds.has(link.to)),
        stack: state.stack.filter((id) => !removedNodeIds.has(id)),
        statuses,
        selectedId: state.selectedId && removedNodeIds.has(state.selectedId) ? null : state.selectedId
      }
    })
  },

  moveNodeToLayer: (nodeId, layerId) => {
    set((state) => {
      if (!state.layers.some((layer) => layer.id === layerId)) return state
      return {
        nodes: state.nodes.map((node) => (node.id === nodeId ? { ...node, layerId } : node))
      }
    })
  },

  addNote: (position, layerId) => {
    const { nodes, layers, camera, viewport } = get()
    const spawn = position ?? cascadePosition(nodes, viewport, camera)
    const layer =
      layerId && layers.some((entry) => entry.id === layerId) ? layerId : (layers[0]?.id ?? DEFAULT_LAYER_ID)
    const node: TerminalNodeModel = {
      id: crypto.randomUUID(),
      title: uniqueTitle(
        nodes.map((existing) => existing.title),
        'Note'
      ),
      layerId: layer,
      kind: 'note',
      text: '',
      color: '#f5c451',
      x: Math.round(spawn.x - 140),
      y: Math.round(spawn.y - 100),
      w: 300,
      h: 220
    }
    set({ nodes: [...nodes, node], stack: [...get().stack, node.id], selectedId: node.id })
    return node.id
  },

  addEditor: (kind = 'editor', position, layerId) => {
    const { nodes, layers, camera, viewport } = get()
    const spawn = position ?? cascadePosition(nodes, viewport, camera)
    const layer = layerId && layers.some((entry) => entry.id === layerId) ? layerId : (layers[0]?.id ?? DEFAULT_LAYER_ID)
    const node: TerminalNodeModel = {
      id: crypto.randomUUID(),
      kind,
      title: kind === 'diff' ? 'Diff' : 'Editor',
      titleCustom: true,
      layerId: layer,
      text: kind === 'editor' ? '// Start editing…' : undefined,
      diff: kind === 'diff' ? '--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-old\n+new' : undefined,
      x: Math.round(position ? spawn.x - DEFAULT_NODE_SIZE.w / 2 : spawn.x),
      y: Math.round(position ? spawn.y - DEFAULT_NODE_SIZE.h / 2 : spawn.y),
      ...DEFAULT_NODE_SIZE
    }
    set({ nodes: [...nodes, node], stack: [...get().stack, node.id], selectedId: node.id })
    return node.id
  },

  addLink: (from, to) => {
    if (from === to) return
    set((state) => {
      if (!state.nodes.some((node) => node.id === from) || !state.nodes.some((node) => node.id === to)) return state
      const exists = state.links.some(
        (link) => (link.from === from && link.to === to) || (link.from === to && link.to === from)
      )
      if (exists) return state
      return { links: [...state.links, { id: crypto.randomUUID(), from, to }] }
    })
  },

  removeLink: (linkId) => {
    set((state) => ({ links: state.links.filter((link) => link.id !== linkId) }))
  }
}))

export { DEFAULT_NODE_SIZE, MIN_NODE_SIZE, DEFAULT_LAYER_ID }
