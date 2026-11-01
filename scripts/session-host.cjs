const net = require('node:net')
const pty = require('node-pty')

// Bumped whenever the wire format changes; the app refuses to talk to a host
// that reports a different value instead of silently mis-reading its replies.
const PROTOCOL = 2
// 0 means "let the OS pick": the app passes an explicit port per run.
const port = Number(process.env.TERMTERM_HOST_PORT || 0)
const sessions = new Map()
const replayLimit = 200 * 1024

function send(socket, message) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`)
}

const server = net.createServer((socket) => {
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      let request
      try {
        request = JSON.parse(line)
      } catch {
        continue
      }
      try {
        handle(socket, request)
      } catch (error) {
        // Include the requestId so the caller sees the reason instead of a timeout.
        send(socket, {
          type: 'error',
          requestId: request && request.requestId,
          nodeId: request && request.nodeId,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
  })
})

function handle(socket, request) {
  if (request.type === 'ping') return send(socket, { type: 'pong', protocol: PROTOCOL, pid: process.pid })
  if (request.type === 'shutdown') {
    send(socket, { type: 'shutdown', requestId: request.requestId })
    shutdown()
    return
  }
  if (request.type === 'spawn') {
    if (sessions.has(request.nodeId)) {
      const current = sessions.get(request.nodeId)
      current.socket = socket
      return send(socket, { type: 'spawned', requestId: request.requestId, nodeId: request.nodeId, pid: current.child.pid, replay: current.history })
    }
    const file = request.file || process.env.COMSPEC || process.env.SHELL || 'cmd.exe'
    const child = pty.spawn(file, request.args || [], {
      name: 'xterm-256color',
      cols: request.cols || 80,
      rows: request.rows || 24,
      cwd: request.cwd || process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color', TERM_PROGRAM: 'TermTerm' }
    })
    const session = { child, socket, history: '', killed: false }
    sessions.set(request.nodeId, session)
    child.onData((data) => {
      session.history = (session.history + data).slice(-replayLimit)
      if (!session.socket.destroyed) send(session.socket, { type: 'data', nodeId: request.nodeId, data })
    })
    child.onExit(({ exitCode, signal }) => {
      sessions.delete(request.nodeId)
      // An intentional kill must not report an exit for the session that replaces it.
      if (session.killed || session.socket.destroyed) return
      send(session.socket, { type: 'exit', nodeId: request.nodeId, pid: child.pid, exitCode, signal })
    })
    send(socket, { type: 'spawned', requestId: request.requestId, nodeId: request.nodeId, pid: child.pid, cwd: request.cwd || process.cwd(), replay: '' })
    return
  }
  const session = sessions.get(request.nodeId)
  if (!session) return send(socket, { type: 'error', nodeId: request.nodeId, message: 'Session is not running' })
  session.socket = socket
  if (request.type === 'write') session.child.write(request.data)
  if (request.type === 'resize') session.child.resize(request.cols, request.rows)
  if (request.type === 'kill') {
    sessions.delete(request.nodeId)
    session.killed = true
    session.child.kill()
    send(socket, { type: 'killed', nodeId: request.nodeId })
  }
}

let closing = false

function shutdown() {
  if (closing) return
  closing = true
  for (const session of sessions.values()) {
    try { session.child.kill() } catch { /* already gone */ }
  }
  sessions.clear()
  server.close(() => process.exit(0))
  // Do not linger if a socket keeps the server open.
  setTimeout(() => process.exit(0), 500).unref()
}

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`TermTerm session host listening on 127.0.0.1:${server.address().port}\n`)
})

server.on('error', (error) => {
  // The port was taken between selection and bind: the app retries on a new one.
  process.stderr.write(`TermTerm session host failed to listen: ${error.message}\n`)
  process.exit(1)
})

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
