import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Camera, Layer, NodeLink, PersistedLayout, TerminalNodeModel } from '../shared/types'

const LAYOUT_VERSION = 3
const DEFAULT_LAYER_ID = 'layer-workspace'
const MAX_NODES = 2000
const MAX_LAYERS = 500
const MAX_LINKS = 4000
const MAX_NOTE_CHARS = 8000
const MAX_SCROLLBACK_CHARS = 200_000
const MAX_LAYOUT_BYTES = 8 * 1024 * 1024

export { DEFAULT_LAYER_ID }

export function layoutPath(): string {
  return join(app.getPath('userData'), 'layout.json')
}

export function defaultLayers(): Layer[] {
  return [{ id: DEFAULT_LAYER_ID, name: 'Workspace', parentId: null, visible: true, collapsed: false }]
}

function coerceNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function coerceNode(value: unknown): TerminalNodeModel | null {
  if (!value || typeof value !== 'object') return null
  const node = value as Record<string, unknown>
  if (typeof node.id !== 'string') return null
  const kind = node.kind === 'note' || node.kind === 'editor' || node.kind === 'diff' ? node.kind : 'terminal'
  const profileId = typeof node.profileId === 'string' && node.profileId.length > 0 ? node.profileId : undefined
  const connectionId =
    typeof node.connectionId === 'string' && node.connectionId.length > 0 ? node.connectionId : undefined
  if (kind === 'terminal' && !profileId && !connectionId) return null
  return {
    id: node.id,
    title: typeof node.title === 'string' && node.title.length > 0 ? node.title.slice(0, 120) : kind === 'note' ? 'Note' : 'Terminal',
    titleCustom: node.titleCustom === true,
    layerId: typeof node.layerId === 'string' && node.layerId.length > 0 ? node.layerId : DEFAULT_LAYER_ID,
    kind,
    text: kind === 'note' && typeof node.text === 'string' ? node.text.slice(0, MAX_NOTE_CHARS) : undefined,
    filePath: (kind === 'editor' || kind === 'diff') && typeof node.filePath === 'string'
      ? node.filePath.slice(0, 4096)
      : undefined,
    diff: kind === 'diff' && typeof node.diff === 'string' ? node.diff.slice(0, MAX_NOTE_CHARS) : undefined,
    color:
      kind === 'note' && typeof node.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(node.color)
        ? node.color
        : kind === 'note'
          ? '#f5c451'
          : undefined,
    profileId,
    connectionId,
    x: coerceNumber(node.x, 0),
    y: coerceNumber(node.y, 0),
    w: Math.max(240, coerceNumber(node.w, 620)),
    h: Math.max(160, coerceNumber(node.h, 400)),
    cwd: typeof node.cwd === 'string' ? node.cwd : undefined,
    splitPaneId:
      kind === 'terminal' && typeof node.splitPaneId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(node.splitPaneId)
        ? node.splitPaneId
        : undefined,
    scrollback:
      kind === 'terminal' && typeof node.scrollback === 'string'
        ? node.scrollback.slice(-MAX_SCROLLBACK_CHARS)
        : undefined
  }
}

function coerceLink(value: unknown): NodeLink | null {
  if (!value || typeof value !== 'object') return null
  const link = value as Record<string, unknown>
  if (typeof link.from !== 'string' || typeof link.to !== 'string') return null
  if (typeof link.id !== 'string' || link.id.length === 0) return null
  if (link.from === link.to) return null
  return { id: link.id, from: link.from, to: link.to }
}

function coerceLayer(value: unknown): Layer | null {
  if (!value || typeof value !== 'object') return null
  const layer = value as Record<string, unknown>
  if (typeof layer.id !== 'string' || layer.id.length === 0) return null
  return {
    id: layer.id,
    name: typeof layer.name === 'string' && layer.name.length > 0 ? layer.name.slice(0, 80) : 'Layer',
    parentId: typeof layer.parentId === 'string' && layer.parentId.length > 0 ? layer.parentId : null,
    visible: layer.visible !== false,
    collapsed: layer.collapsed === true
  }
}

/** Drops dangling parents and breaks cycles so a corrupt file cannot hang the UI. */
function normaliseLayers(layers: Layer[]): Layer[] {
  const byId = new Map(layers.map((layer) => [layer.id, layer]))
  for (const layer of layers) {
    if (layer.parentId === layer.id || (layer.parentId && !byId.has(layer.parentId))) layer.parentId = null
  }
  for (const layer of layers) {
    const seen = new Set<string>([layer.id])
    let cursor = layer.parentId
    let depth = 0
    while (cursor) {
      if (seen.has(cursor) || depth > MAX_LAYERS) {
        layer.parentId = null
        break
      }
      seen.add(cursor)
      cursor = byId.get(cursor)?.parentId ?? null
      depth += 1
    }
  }
  return layers
}

function coerceCamera(value: unknown): Camera {
  const camera = (value ?? {}) as Record<string, unknown>
  return {
    x: coerceNumber(camera.x, 0),
    y: coerceNumber(camera.y, 0),
    zoom: Math.min(3, Math.max(0.12, coerceNumber(camera.zoom, 1)))
  }
}

export function sanitizeLayout(value: unknown): PersistedLayout {
  const raw = (value ?? {}) as Record<string, unknown>
  const layers = normaliseLayers(
    (Array.isArray(raw.layers) ? raw.layers : [])
      .slice(0, MAX_LAYERS)
      .map(coerceLayer)
      .filter((layer): layer is Layer => layer !== null)
  )
  const effectiveLayers = layers.length > 0 ? layers : defaultLayers()
  const knownLayers = new Set(effectiveLayers.map((layer) => layer.id))
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : [])
    .slice(0, MAX_NODES)
    .map(coerceNode)
    .filter((node): node is TerminalNodeModel => node !== null)
    .map((node) => (knownLayers.has(node.layerId) ? node : { ...node, layerId: effectiveLayers[0].id }))

  const nodeIds = new Set(nodes.map((node) => node.id))
  const seenLinks = new Set<string>()
  const links = (Array.isArray(raw.links) ? raw.links : [])
    .slice(0, MAX_LINKS)
    .map(coerceLink)
    .filter((link): link is NodeLink => link !== null)
    .filter((link) => {
      // Dangling links would render into empty space.
      if (!nodeIds.has(link.from) || !nodeIds.has(link.to)) return false
      const key = [link.from, link.to].sort().join('|')
      if (seenLinks.has(key)) return false
      seenLinks.add(key)
      return true
    })

  return { version: LAYOUT_VERSION, nodes, layers: effectiveLayers, links, camera: coerceCamera(raw.camera) }
}

export function loadLayout(): PersistedLayout | null {
  const path = layoutPath()
  if (!existsSync(path)) return null
  try {
    const text = readFileSync(path, 'utf8')
    if (text.length > MAX_LAYOUT_BYTES) return null
    return sanitizeLayout(JSON.parse(text))
  } catch {
    return null
  }
}

export function saveLayout(layout: PersistedLayout): void {
  const payload = sanitizeLayout(layout)
  const path = layoutPath()
  mkdirSync(dirname(path), { recursive: true })
  const tempPath = `${path}.tmp`
  writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8')
  renameSync(tempPath, path)
}
