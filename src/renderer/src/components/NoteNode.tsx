import type { CSSProperties } from 'react'
import type { TerminalNodeModel } from '@shared/types'
import { useAppStore } from '@/state/useAppStore'
import { RESIZE_HANDLES, useNodeFrame } from '@/lib/useNodeFrame'
import { CloseIcon } from './icons'

const NOTE_COLORS = ['#f5c451', '#7dd3fc', '#86efac', '#f9a8d4', '#c4b5fd', '#fdba74']

interface Props {
  node: TerminalNodeModel
  selected: boolean
  zIndex?: number
  /** Terminals this note is linked to; each can receive the note text. */
  linkedTargets: Array<{ id: string; title: string }>
  onStartLink: (nodeId: string, event: React.PointerEvent) => void
  onSendTo: (targetId: string, text: string) => void
}

export function NoteNode({ node, selected, zIndex, linkedTargets, onStartLink, onSendTo }: Props) {
  const updateNode = useAppStore((state) => state.updateNode)
  const requestCloseNode = useAppStore((state) => state.requestCloseNode)
  const selectNode = useAppStore((state) => state.selectNode)
  const bringToFront = useAppStore((state) => state.bringToFront)
  const { beginDrag, beginResize } = useNodeFrame(node)

  const style = {
    '--nx': node.x,
    '--ny': node.y,
    '--nw': node.w,
    '--nh': node.h,
    '--note-color': node.color ?? NOTE_COLORS[0],
    zIndex: zIndex ?? 1
  } as CSSProperties

  return (
    <section
      className={`node note${selected ? ' selected' : ''}`}
      style={style}
      data-node-id={node.id}
      onPointerDown={() => {
        selectNode(node.id)
        bringToFront(node.id)
      }}
    >
      <div className="node-port left" onPointerDown={(event) => onStartLink(node.id, event)} />
      <div className="node-port right" onPointerDown={(event) => onStartLink(node.id, event)} />

      <header className="note-header" onPointerDown={beginDrag}>
        <span className="note-dot" />
        <span className="note-title">Note</span>
        <div className="note-colors">
          {NOTE_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={`note-color${(node.color ?? NOTE_COLORS[0]) === color ? ' active' : ''}`}
              style={{ background: color }}
              title="Note colour"
              onClick={() => updateNode(node.id, { color })}
            />
          ))}
        </div>
        <button type="button" className="icon-button" title="Delete note" onClick={() => requestCloseNode(node.id)}>
          <CloseIcon size={13} />
        </button>
      </header>

      <textarea
        className="note-text"
        value={node.text ?? ''}
        placeholder="Write a note… (linked terminals can receive this text)"
        spellCheck={false}
        onPointerDown={(event) => event.stopPropagation()}
        onChange={(event) => updateNode(node.id, { text: event.target.value })}
      />

      {linkedTargets.length > 0 ? (
        <footer className="note-links">
          {linkedTargets.map((target) => (
            <span key={target.id} className="note-link-chip">
              <span className="note-link-name">{target.title}</span>
              <button
                type="button"
                className="note-send"
                title={`Type this note into ${target.title}`}
                disabled={!(node.text ?? '').trim()}
                onClick={() => onSendTo(target.id, node.text ?? '')}
              >
                send
              </button>
            </span>
          ))}
        </footer>
      ) : null}

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
