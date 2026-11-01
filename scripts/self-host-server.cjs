const http = require('node:http')
const { readFileSync, existsSync } = require('node:fs')
const { extname, join, normalize } = require('node:path')
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto')
const pty = require('node-pty')

const port = Number(process.env.PORT || 8787)
const root = join(__dirname, '..', 'out', 'renderer')
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' }
const token = process.env.TERMTERM_TOKEN || randomBytes(24).toString('hex')
const sessions = new Map()

function frame(payload, opcode = 1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  let header
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length])
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(body.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(body.length), 2)
  }
  return Buffer.concat([header, body])
}

function readFrame(buffer) {
  if (buffer.length < 2) return null
  const masked = Boolean(buffer[1] & 0x80)
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return null
    length = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  if (masked) {
    if (buffer.length < offset + 4) return null
  }
  const total = offset + (masked ? 4 : 0) + length
  if (buffer.length < total) return null
  const payload = Buffer.from(buffer.subarray(offset + (masked ? 4 : 0), total))
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4)
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
  }
  return { payload, total, opcode: buffer[0] & 0x0f }
}

function send(socket, message) {
  if (!socket.destroyed) socket.write(frame(JSON.stringify(message)))
}

function tokenMatches(candidate) {
  if (typeof candidate !== 'string') return false
  const actual = Buffer.from(token)
  const supplied = Buffer.from(candidate)
  return actual.length === supplied.length && timingSafeEqual(actual, supplied)
}

const server = http.createServer((request, response) => {
  if (request.url === '/api/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ service: 'TermTerm', status: 'ok' }))
    return
  }
  let pathname = decodeURIComponent((request.url || '/').split('?')[0])
  if (pathname === '/') pathname = '/index.html'
  const target = normalize(join(root, pathname))
  if (!target.startsWith(root) || !existsSync(target)) {
    response.writeHead(404)
    response.end('Not found')
    return
  }
  response.writeHead(200, { 'content-type': types[extname(target)] || 'application/octet-stream' })
  response.end(readFileSync(target))
})

server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/termterm') {
    socket.destroy()
    return
  }
  const key = request.headers['sec-websocket-key']
  if (!key) {
    socket.destroy()
    return
  }
  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64')
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    ''
  ].join('\r\n'))

  let authenticated = false
  let pending = head
  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk])
    while (pending.length > 0) {
      const parsed = readFrame(pending)
      if (!parsed) break
      pending = pending.subarray(parsed.total)
      if (parsed.opcode === 8) {
        socket.destroy()
        break
      }
      if (parsed.opcode === 9) {
        socket.write(frame(parsed.payload, 10))
        continue
      }
      if (parsed.opcode !== 1) continue
      let message
      try { message = JSON.parse(parsed.payload.toString('utf8')) } catch {
        send(socket, { type: 'error', message: 'Invalid JSON' })
        continue
      }
      if (!authenticated) {
        authenticated = tokenMatches(message.token)
        send(socket, { type: authenticated ? 'authenticated' : 'error', message: authenticated ? undefined : 'Authentication required' })
        if (!authenticated) socket.end(frame(Buffer.from([0x03, 0xe8]), 8))
        continue
      }
      const id = message.nodeId
      if (message.type === 'spawn') {
        if (!sessions.has(id)) {
          const child = pty.spawn(message.file || (process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/sh'), message.args || [], {
            name: 'xterm-256color',
            cols: message.cols || 80,
            rows: message.rows || 24,
            cwd: message.cwd || process.cwd(),
            env: { ...process.env, TERM: 'xterm-256color' }
          })
          const session = { child, history: '' }
          sessions.set(id, session)
          child.onData((data) => {
            session.history = (session.history + data).slice(-200 * 1024)
            send(socket, { type: 'data', nodeId: id, data })
          })
          child.onExit(({ exitCode, signal }) => {
            sessions.delete(id)
            send(socket, { type: 'exit', nodeId: id, exitCode, signal })
          })
        }
        const session = sessions.get(id)
        send(socket, { type: 'spawned', nodeId: id, pid: session.child.pid, replay: session.history })
      } else if (message.type === 'write') {
        sessions.get(id)?.child.write(message.data || '')
      } else if (message.type === 'resize') {
        sessions.get(id)?.child.resize(message.cols || 80, message.rows || 24)
      } else if (message.type === 'kill') {
        sessions.get(id)?.child.kill()
        sessions.delete(id)
      }
    }
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`TermTerm self-host UI available at http://127.0.0.1:${port}\n`)
  if (!process.env.TERMTERM_TOKEN) process.stdout.write(`TermTerm self-host token: ${token}\n`)
})
