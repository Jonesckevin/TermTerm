import type { Camera, TerminalNodeModel } from '@shared/types'

export const MIN_ZOOM = 0.12
export const MAX_ZOOM = 2.5

export interface Size {
  w: number
  h: number
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

export function screenToWorld(camera: Camera, screenX: number, screenY: number): { x: number; y: number } {
  return { x: (screenX - camera.x) / camera.zoom, y: (screenY - camera.y) / camera.zoom }
}

export function nodesBounds(nodes: TerminalNodeModel[]): { x: number; y: number; w: number; h: number } | null {
  if (nodes.length === 0) return null
  const minX = Math.min(...nodes.map((node) => node.x))
  const minY = Math.min(...nodes.map((node) => node.y))
  const maxX = Math.max(...nodes.map((node) => node.x + node.w))
  const maxY = Math.max(...nodes.map((node) => node.y + node.h))
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function fitCamera(
  nodes: TerminalNodeModel[],
  viewport: Size,
  padding = 80
): Camera | null {
  const bounds = nodesBounds(nodes)
  if (!bounds || viewport.w === 0 || viewport.h === 0) return null
  const zoom = clampZoom(
    Math.min((viewport.w - padding * 2) / bounds.w, (viewport.h - padding * 2) / bounds.h, 1)
  )
  return {
    zoom,
    x: (viewport.w - bounds.w * zoom) / 2 - bounds.x * zoom,
    y: (viewport.h - bounds.h * zoom) / 2 - bounds.y * zoom
  }
}

export function centerOnNode(node: TerminalNodeModel, viewport: Size, zoom: number): Camera {
  return {
    zoom,
    x: viewport.w / 2 - (node.x + node.w / 2) * zoom,
    y: viewport.h / 2 - (node.y + node.h / 2) * zoom
  }
}

/** Distance between viewport-centre and node-centre, used to cascade new nodes. */
export function cascadePosition(nodes: TerminalNodeModel[], viewport: Size, camera: Camera): { x: number; y: number } {
  const center = screenToWorld(camera, viewport.w / 2, viewport.h / 2)
  const step = 36
  let x = Math.round(center.x - 310)
  let y = Math.round(center.y - 200)
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const overlap = nodes.some(
      (node) => Math.abs(node.x - x) < 40 && Math.abs(node.y - y) < 40
    )
    if (!overlap) break
    x += step
    y += step
  }
  return { x, y }
}
