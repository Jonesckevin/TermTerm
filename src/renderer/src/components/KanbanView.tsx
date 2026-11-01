import { useAppStore, type SessionStatus } from '@/state/useAppStore'

const columns: Array<{ key: SessionStatus | 'note'; label: string }> = [
  { key: 'starting', label: 'Starting' },
  { key: 'running', label: 'Running' },
  { key: 'exited', label: 'Stopped' },
  { key: 'note', label: 'Notes & editors' }
]

export function KanbanView({ onClose }: { onClose: () => void }) {
  const nodes = useAppStore((state) => state.nodes)
  const statuses = useAppStore((state) => state.statuses)
  const focusNode = useAppStore((state) => state.focusNode)

  return (
    <div className="kanban-backdrop" role="dialog" aria-modal="true" aria-label="Session board">
      <div className="kanban">
        <header>
          <h2>Session board</h2>
          <button type="button" className="ghost-button" onClick={onClose}>Close</button>
        </header>
        <div className="kanban-columns">
          {columns.map((column) => {
            const cards = nodes.filter((node) => {
              if (column.key === 'note') return node.kind === 'note' || node.kind === 'editor' || node.kind === 'diff'
              return node.kind !== 'note' && node.kind !== 'editor' && node.kind !== 'diff' && statuses[node.id] === column.key
            })
            return (
              <section key={column.key}>
                <h3>{column.label}<span>{cards.length}</span></h3>
                {cards.map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    onClick={() => {
                      focusNode(node.id)
                      onClose()
                    }}
                  >
                    {node.title}
                  </button>
                ))}
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}
