import { useEffect, useRef } from 'react'

export interface MenuEntry {
  label: string
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  onSelect?: () => void
}

export interface ContextMenuState {
  x: number
  y: number
  entries: Array<MenuEntry | 'separator'>
}

interface Props {
  menu: ContextMenuState
  onClose: () => void
}

export function ContextMenu({ menu, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [onClose])

  return (
    <div
      className="context-menu"
      ref={ref}
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {menu.entries.map((entry, index) =>
        entry === 'separator' ? (
          <div className="context-menu-separator" key={`sep-${index}`} />
        ) : (
          <button
            key={`${entry.label}-${index}`}
            className={`context-menu-item${entry.danger ? ' danger' : ''}`}
            disabled={entry.disabled}
            onClick={() => {
              entry.onSelect?.()
              onClose()
            }}
          >
            <span>{entry.label}</span>
            {entry.shortcut ? <kbd>{entry.shortcut}</kbd> : null}
          </button>
        )
      )}
    </div>
  )
}
