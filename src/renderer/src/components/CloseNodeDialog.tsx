import { useAppStore } from '@/state/useAppStore'
import { ConfirmDialog } from './ConfirmDialog'

/**
 * The single confirmation path for closing or deleting a node. Every entry point
 * (header button, node menu, sidebar, Ctrl+Shift+W, layer purge) goes through it.
 */
export function CloseNodeDialog() {
  const closeRequestId = useAppStore((state) => state.closeRequestId)
  const node = useAppStore((state) =>
    state.nodes.find((candidate) => candidate.id === state.closeRequestId)
  )
  const connection = useAppStore((state) =>
    state.connections.find((candidate) => candidate.id === node?.connectionId)
  )
  const cancelCloseNode = useAppStore((state) => state.cancelCloseNode)
  const removeNode = useAppStore((state) => state.removeNode)

  if (!closeRequestId || !node) return null

  const isNote = node.kind === 'note'
  const isEditor = node.kind === 'editor' || node.kind === 'diff'
  const label = isNote
    ? node.text?.trim().split('\n')[0]?.slice(0, 42) || 'Empty note'
    : node.titleCustom
      ? node.title
      : (connection?.name ?? node.title)
  const noun = node.kind === 'diff' ? 'diff' : node.kind === 'editor' ? 'editor' : 'note'

  const confirm = (): void => {
    if (!isNote && !isEditor) {
      window.termterm.kill(node.id)
      if (node.splitPaneId) window.termterm.kill(node.splitPaneId)
    }
    removeNode(node.id)
  }

  return (
    <ConfirmDialog
      open
      title={isNote || isEditor ? `Delete ${noun}?` : 'Close terminal?'}
      body={
        isNote || isEditor
          ? `Delete “${label}”? You can undo the removal immediately afterwards.`
          : `Close “${label}”? Its running process will end. You can undo the removal immediately afterwards.`
      }
      choices={[
        {
          label: isNote || isEditor ? `Delete ${noun}` : 'Close terminal',
          hint: isNote || isEditor ? undefined : 'Scrollback is kept in the layout for undo',
          tone: 'danger',
          onSelect: confirm
        }
      ]}
      onClose={cancelCloseNode}
    />
  )
}
