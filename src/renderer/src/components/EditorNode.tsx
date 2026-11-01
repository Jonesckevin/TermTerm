import type { CSSProperties } from 'react'
import type { TerminalNodeModel } from '@shared/types'
import { useAppStore } from '@/state/useAppStore'
import { RESIZE_HANDLES, useNodeFrame } from '@/lib/useNodeFrame'
import { CloseIcon } from './icons'

interface Props {
  node: TerminalNodeModel
  selected: boolean
  zIndex?: number
}

export function EditorNode({ node, selected, zIndex }: Props) {
  const updateNode = useAppStore((state) => state.updateNode)
  const requestCloseNode = useAppStore((state) => state.requestCloseNode)
  const { beginDrag, beginResize } = useNodeFrame(node)
  const isDiff = node.kind === 'diff'
  const style = {
    '--nx': node.x,
    '--ny': node.y,
    '--nw': node.w,
    '--nh': node.h,
    zIndex: zIndex ?? 1
  } as CSSProperties

  return (
    <section
      className={`node editor-node${selected ? ' selected' : ''}`}
      style={style}
      data-node-id={node.id}
      onPointerDown={() => {
        useAppStore.getState().selectNode(node.id)
        useAppStore.getState().bringToFront(node.id)
      }}
    >
      <header className="note-header" onPointerDown={beginDrag}>
        <span className="note-dot" />
        <span className="note-title">{isDiff ? 'Diff' : 'Editor'}</span>
        <input
          className="editor-path"
          value={node.filePath ?? ''}
          placeholder="Untitled"
          aria-label="Editor file path"
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) => updateNode(node.id, { filePath: event.target.value })}
        />
        <button type="button" className="icon-button" title={`Delete ${isDiff ? 'diff' : 'editor'}`} onClick={() => requestCloseNode(node.id)}>
          <CloseIcon size={13} />
        </button>
      </header>
      <textarea
        className={`editor-text${isDiff ? ' diff-text' : ''}`}
        value={isDiff ? (node.diff ?? '') : (node.text ?? '')}
        spellCheck={false}
        aria-label={isDiff ? 'Diff content' : 'Editor content'}
        onPointerDown={(event) => event.stopPropagation()}
        onChange={(event) => updateNode(node.id, isDiff ? { diff: event.target.value } : { text: event.target.value })}
      />
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
