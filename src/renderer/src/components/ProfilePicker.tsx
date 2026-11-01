import { useEffect, useMemo, useRef, useState } from 'react'
import type { SavedConnection, ShellProfile } from '@shared/types'
import { ProfileBadge } from './ProfileBadge'
import { SearchIcon } from './icons'

interface Props {
  open: boolean
  profiles: ShellProfile[]
  connections: SavedConnection[]
  onClose: () => void
  onSelect: (target: { profileId: string } | { connectionId: string }) => void
}

interface LauncherItem {
  id: string
  name: string
  detail?: string
  kind: string
  badge: SavedConnection | ShellProfile
  target: { profileId: string } | { connectionId: string }
}

export function ProfilePicker({ open, profiles, connections, onClose, onSelect }: Props) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const items = useMemo<LauncherItem[]>(() => [
    ...profiles.map((profile) => ({
      id: `profile:${profile.id}`,
      name: profile.name,
      detail: profile.detail,
      kind: profile.kind,
      badge: profile,
      target: { profileId: profile.id }
    })),
    ...connections.map((connection) => ({
      id: `connection:${connection.id}`,
      name: connection.name,
      detail: `${connection.kind}://${connection.host}${connection.port ? `:${connection.port}` : ''}`,
      kind: connection.kind,
      badge: connection,
      target: { connectionId: connection.id }
    }))
  ], [profiles, connections])

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return items
    return items.filter((item) =>
      [item.name, item.detail ?? '', item.kind].join(' ').toLowerCase().includes(needle)
    )
  }, [items, query])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    const timer = setTimeout(() => inputRef.current?.focus(), 20)
    return () => clearTimeout(timer)
  }, [open])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  useEffect(() => {
    const item = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
    item?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (!open) return null

  const choose = (target: LauncherItem['target']): void => {
    onSelect(target)
    onClose()
  }

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="picker" onPointerDown={(event) => event.stopPropagation()} role="dialog" aria-label="New terminal">
        <div className="picker-input">
          <SearchIcon size={15} />
          <input
            ref={inputRef}
            value={query}
            autoFocus
            placeholder="Start a terminal…"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                onClose()
                return
              }
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActiveIndex((index) => Math.min(matches.length - 1, index + 1))
                return
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActiveIndex((index) => Math.max(0, index - 1))
                return
              }
              if (event.key === 'Enter' && matches[activeIndex]) {
                choose(matches[activeIndex].target)
              }
            }}
          />
        </div>

        <div className="picker-list" ref={listRef}>
          {matches.map((item, index) => (
            <button
              key={item.id}
              data-index={index}
              className={`picker-item${index === activeIndex ? ' active' : ''}`}
              onPointerEnter={() => setActiveIndex(index)}
              onClick={() => choose(item.target)}
            >
              <ProfileBadge profile={item.badge} size={26} />
              <span className="picker-item-text">
                <span className="picker-item-name">
                  {item.name}
                  {'isDefault' in item.badge && item.badge.isDefault
                    ? <span className="picker-item-default">default</span>
                    : null}
                </span>
                {item.detail ? <span className="picker-item-detail">{item.detail}</span> : null}
              </span>
              <span className="picker-item-kind">{item.kind}</span>
            </button>
          ))}
          {matches.length === 0 ? <div className="picker-empty">No shells match “{query}”.</div> : null}
        </div>

        <div className="picker-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>Enter</kbd> open
          </span>
          <span>
            <kbd>Esc</kbd> dismiss
          </span>
        </div>
      </div>
    </div>
  )
}
