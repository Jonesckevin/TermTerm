import type { PointerEvent as ReactPointerEvent } from 'react'
import type { TerminalNodeModel } from '@shared/types'
import { useAppStore } from '@/state/useAppStore'

export type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export const RESIZE_HANDLES: ResizeDirection[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

/** Drag-by-header and 8-way resize, shared by terminal and note nodes. */
export function useNodeFrame(node: TerminalNodeModel) {
  const updateNode = useAppStore((state) => state.updateNode)
  const selectNode = useAppStore((state) => state.selectNode)
  const bringToFront = useAppStore((state) => state.bringToFront)

  const beginDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('button, input, textarea')) return
    selectNode(node.id)
    bringToFront(node.id)
    const zoomNow = useAppStore.getState().camera.zoom
    const startX = event.clientX
    const startY = event.clientY
    const origin = { x: node.x, y: node.y }

    const onMove = (moveEvent: PointerEvent): void => {
      updateNode(node.id, {
        x: origin.x + (moveEvent.clientX - startX) / zoomNow,
        y: origin.y + (moveEvent.clientY - startY) / zoomNow
      })
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>, direction: ResizeDirection): void => {
    event.stopPropagation()
    event.preventDefault()
    const zoomNow = useAppStore.getState().camera.zoom
    const startX = event.clientX
    const startY = event.clientY
    const origin = { x: node.x, y: node.y, w: node.w, h: node.h }

    const onMove = (moveEvent: PointerEvent): void => {
      const dx = (moveEvent.clientX - startX) / zoomNow
      const dy = (moveEvent.clientY - startY) / zoomNow
      const next = { x: origin.x, y: origin.y, w: origin.w, h: origin.h }
      if (direction.includes('e')) next.w = origin.w + dx
      if (direction.includes('s')) next.h = origin.h + dy
      if (direction.includes('w')) {
        next.w = origin.w - dx
        next.x = origin.x + dx
      }
      if (direction.includes('n')) {
        next.h = origin.h - dy
        next.y = origin.y + dy
      }
      updateNode(node.id, next)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return { beginDrag, beginResize }
}
