import type { PtyDataEvent, PtyExitEvent } from '@shared/types'

type DataHandler = (data: string) => void
type ExitHandler = (event: PtyExitEvent) => void

const dataHandlers = new Map<string, Set<DataHandler>>()
const exitHandlers = new Map<string, Set<ExitHandler>>()

function attach<T>(map: Map<string, Set<T>>, nodeId: string, handler: T, off: () => void): () => void {
  const set = map.get(nodeId) ?? new Set<T>()
  set.add(handler)
  map.set(nodeId, set)
  return () => {
    void off
    const current = map.get(nodeId)
    if (!current) return
    current.delete(handler)
    if (current.size === 0) map.delete(nodeId)
  }
}

let listenersBound = false

/** Routes main-process PTY events to the terminal component that owns each node. */
export const ptyBus = {
  ensureBound(): void {
    if (listenersBound) return
    listenersBound = true
    window.termterm.onData((event: PtyDataEvent) => {
      const handlers = dataHandlers.get(event.nodeId)
      if (!handlers) return
      for (const handler of handlers) handler(event.data)
    })
    window.termterm.onExit((event: PtyExitEvent) => {
      const handlers = exitHandlers.get(event.nodeId)
      if (!handlers) return
      for (const handler of handlers) handler(event)
    })
  },
  onData(nodeId: string, handler: DataHandler): () => void {
    return attach(dataHandlers, nodeId, handler, () => undefined)
  },
  onExit(nodeId: string, handler: ExitHandler): () => void {
    return attach(exitHandlers, nodeId, handler, () => undefined)
  }
}
