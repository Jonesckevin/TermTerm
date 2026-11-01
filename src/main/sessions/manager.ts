import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import { spawn as spawnChild } from 'node:child_process'
import { connect as connectSocket } from 'node:net'
import type { ChildProcess } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import type { Socket } from 'node:net'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import type { ShellProfile, SpawnRequest, SpawnResult } from '../../shared/types'
import { buildSpawnSpec } from '../pty/profiles'
import type { Vault } from '../vault'
import { x11Status } from '../x11'
import { buildConnectionSpec } from './connections'
import { TelnetFilter } from './telnet'

const FLUSH_INTERVAL_MS = 8
const MAX_BUFFER_CHARS = 64 * 1024
const MAX_LAUNCHER_STDERR = 8 * 1024
const MAX_SESSION_REPLAY_CHARS = 200 * 1024

/** Must match PROTOCOL in scripts/session-host.cjs. */
const HOST_PROTOCOL = 2
const HOST_START_ATTEMPTS = 3
const HOST_READY_ATTEMPTS = 60
const HOST_READY_INTERVAL_MS = 100
const HOST_HANDSHAKE_TIMEOUT_MS = 1500
const HOST_REQUEST_TIMEOUT_MS = 15_000

/** Asks the OS for an unused loopback port; the host binds it in the same run. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('No free port'))))
    })
  })
}

function openSocket(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket(port, '127.0.0.1')
    socket.once('connect', () => resolve(socket))
    socket.once('error', (error: Error) => {
      socket.destroy()
      reject(error)
    })
  })
}

function handshake(socket: Socket): Promise<HostResponse> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => finish(new Error('No handshake reply')), HOST_HANDSHAKE_TIMEOUT_MS)
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      try {
        const message = JSON.parse(buffer.slice(0, newline)) as HostResponse
        if (message.type === 'pong') finish(null, message)
      } catch {
        finish(new Error('Malformed handshake reply'))
      }
    }
    const onClose = (): void => finish(new Error('Host closed the connection'))
    const finish = (error: Error | null, message?: HostResponse): void => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('close', onClose)
      if (error) reject(error)
      else resolve(message as HostResponse)
    }
    socket.on('data', onData)
    socket.on('close', onClose)
    socket.write(`${JSON.stringify({ type: 'ping' })}\n`)
  })
}

interface SessionBase {
  nodeId: string
  buffer: string
  flushTimer: NodeJS.Timeout | null
  pid: number
  history: string
}

interface HostResponse {
  requestId?: number
  type?: string
  nodeId?: string
  message?: string
  pid?: number
  replay?: string
  data?: string
  exitCode?: number
  signal?: number
  cwd?: string
  /** Reported by ping so a host from a different build is rejected. */
  protocol?: number
}

interface PtySession extends SessionBase {
  kind: 'pty'
  process: IPty
  profileId: string
  cwd: string
}

interface SocketSession extends SessionBase {
  kind: 'socket'
  socket: Socket
  filter: TelnetFilter
}

interface LauncherSession extends SessionBase {
  kind: 'launcher'
  child: ChildProcess
  launched: string
}

interface HostSession extends SessionBase {
  kind: 'host'
  profileId: string
  cwd: string
}

type Session = PtySession | SocketSession | LauncherSession | HostSession

function safeCwd(candidate?: string): string {
  if (candidate && existsSync(candidate)) {
    try {
      if (statSync(candidate).isDirectory()) return candidate
    } catch {
      // fall through to home
    }
  }
  return homedir()
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>()
  private hostSocket: Socket | null = null
  private hostChild: ChildProcess | null = null
  /** Set when the detached host cannot be started, so shells run in-process instead. */
  private hostUnavailable = false
  /** Blocks new work while quitting, so a late request cannot respawn the host. */
  private shuttingDown = false
  private hostBuffer = ''
  private readonly hostRequests = new Map<number, (message: HostResponse) => void>()
  private hostRequestId = 0

  constructor(
    private readonly send: (channel: string, payload: unknown) => void,
    private readonly resolveProfile: (profileId: string) => ShellProfile | undefined,
    private readonly vault: Vault,
    private readonly hostScript?: string
  ) {}

  has(nodeId: string): boolean {
    return this.sessions.has(nodeId)
  }

  async spawn(request: SpawnRequest): Promise<SpawnResult> {
    if (this.shuttingDown) throw new Error('TermTerm is closing')
    const existing = this.sessions.get(request.nodeId)
    if (existing) return this.describe(existing)

    if (request.connectionId) return this.spawnConnection(request)
    return this.spawnShell(request)
  }

  write(nodeId: string, data: string): void {
    const session = this.sessions.get(nodeId)
    if (!session) return
    try {
      if (session.kind === 'pty') session.process.write(data)
      else if (session.kind === 'socket') {
        // TELNET expects CR LF for Enter even though xterm sends a bare CR.
        session.socket.write(data.replace(/\r(?!\n)/g, '\r\n'))
      }
      else if (session.kind === 'host') this.sendHost({ type: 'write', nodeId, data })
    } catch {
      // The peer can close between a keystroke and the write landing.
    }
  }

  resize(nodeId: string, cols: number, rows: number): void {
    const session = this.sessions.get(nodeId)
    if (!session) return
    if (session.kind === 'host') {
      this.sendHost({ type: 'resize', nodeId, cols: Math.max(2, cols), rows: Math.max(2, rows) })
      return
    }
    if (session.kind !== 'pty') return
    try {
      session.process.resize(Math.max(2, Math.min(1000, Math.floor(cols))), Math.max(2, Math.min(1000, Math.floor(rows))))
    } catch {
      // resizing a shell that is concurrently exiting throws; ignore.
    }
  }

  kill(nodeId: string): void {
    const session = this.sessions.get(nodeId)
    if (!session) return
    this.sessions.delete(nodeId)
    if (session.flushTimer) clearTimeout(session.flushTimer)
    session.buffer = ''
    try {
      if (session.kind === 'pty') session.process.kill()
      else if (session.kind === 'socket') session.socket.destroy()
      else if (session.kind === 'launcher') session.child.kill()
      else this.sendHost({ type: 'kill', nodeId })
    } catch {
      // already gone
    }
  }

  killAll(): void {
    for (const nodeId of [...this.sessions.keys()]) this.kill(nodeId)
  }

  private async spawnShell(request: SpawnRequest): Promise<SpawnResult> {
    const profile = request.profileId ? this.resolveProfile(request.profileId) : undefined
    if (!profile) throw new Error('Unknown shell profile')

    const spec = buildSpawnSpec(profile, request.cwd)
    if (this.hostScript && !this.hostUnavailable) {
      try {
        const response = await this.requestHost({
          type: 'spawn',
          nodeId: request.nodeId,
          file: spec.file,
          args: spec.args,
          cwd: spec.cwd ?? request.cwd ?? '',
          cols: request.cols,
          rows: request.rows
        })
        if (response.type === 'error') throw new Error(response.message ?? 'Session host failed to start')
        const session: HostSession = {
          kind: 'host',
          nodeId: request.nodeId,
          profileId: profile.id,
          cwd: response.cwd ?? spec.cwd ?? request.cwd ?? '',
          pid: response.pid ?? 0,
          buffer: '',
          flushTimer: null,
          history: response.replay ?? ''
        }
        this.track(session)
        return {
          nodeId: request.nodeId,
          pid: session.pid,
          profileId: profile.id,
          cwd: session.cwd,
          replay: session.history
        }
      } catch (error) {
        // A shell that cannot start is worse than a shell that will not persist.
        this.hostUnavailable = true
        this.resetHost()
        console.error('Detached session host unavailable; starting shells in-process', error)
      }
    }
    const child = pty.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: Math.max(2, Math.floor(request.cols)),
      rows: Math.max(2, Math.floor(request.rows)),
      cwd: safeCwd(spec.cwd ?? request.cwd),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'TermTerm',
        TERM_PROGRAM_VERSION: '0.2.0'
      } as Record<string, string>,
      useConpty: process.platform === 'win32'
    })

    const session: PtySession = {
      kind: 'pty',
      nodeId: request.nodeId,
      process: child,
      profileId: profile.id,
      cwd: spec.cwd ?? '',
      buffer: '',
      flushTimer: null,
      pid: child.pid,
      history: ''
    }
    this.track(session)

    child.onData((data) => this.queue(session, data))
    child.onExit(({ exitCode, signal }) => {
      if (this.sessions.get(request.nodeId)?.pid !== child.pid) return
      this.finish(session, exitCode, signal)
    })

    return {
      nodeId: request.nodeId,
      pid: child.pid,
      profileId: profile.id,
      cwd: spec.cwd ?? '',
      ...(this.hostScript
        ? { warning: 'The detached session host is unavailable, so this shell runs inside TermTerm and closes with it.' }
        : {})
    }
  }

  private spawnConnection(request: SpawnRequest): SpawnResult {
    // Throws VaultLockedError when the vault has not been unlocked.
    const connection = this.vault.connectionById(request.connectionId as string)
    if (!connection) throw new Error('That saved connection no longer exists')

    const spec = buildConnectionSpec(connection, this.vault.secretFor(connection.id), x11Status())

    if (spec.transport === 'socket') {
      const socket = createConnection({ host: spec.host, port: spec.port })
      const session: SocketSession = {
        kind: 'socket',
        nodeId: request.nodeId,
        socket,
        filter: new TelnetFilter(),
        buffer: '',
        flushTimer: null,
        pid: 0,
        history: ''
      }
      this.track(session)

      socket.on('data', (chunk: Buffer) => {
        const { text, replies } = session.filter.process(chunk)
        for (const reply of replies) socket.write(reply)
        if (text.length > 0) this.queue(session, text.toString('utf8'))
      })
      socket.on('error', (error: Error) => {
        this.queue(session, `\r\n\x1b[31m${error.message}\x1b[0m\r\n`)
      })
      socket.on('close', () => {
        if (this.sessions.get(request.nodeId) !== session) return
        this.finish(session, 0)
      })

      return { nodeId: request.nodeId, pid: 0, profileId: '', cwd: '' }
    }

    if (spec.transport === 'launcher') {
      return this.spawnLauncher(request, spec.file, spec.args, spec.launched, spec.stdinSecret)
    }

    const child = pty.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: Math.max(2, Math.floor(request.cols)),
      rows: Math.max(2, Math.floor(request.rows)),
      cwd: safeCwd(request.cwd),
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'TermTerm' } as Record<string, string>,
      useConpty: process.platform === 'win32'
    })

    const session: PtySession = {
      kind: 'pty',
      nodeId: request.nodeId,
      process: child,
      profileId: '',
      cwd: '',
      buffer: '',
      flushTimer: null,
      pid: child.pid,
      history: ''
    }
    this.track(session)
    child.onData((data) => this.queue(session, data))
    child.onExit(({ exitCode, signal }) => {
      if (this.sessions.get(request.nodeId)?.pid !== child.pid) return
      this.finish(session, exitCode, signal)
    })

    return { nodeId: request.nodeId, pid: child.pid, profileId: '', cwd: '', warning: spec.warning }
  }

  private spawnLauncher(
    request: SpawnRequest,
    file: string,
    args: string[],
    launched: string,
    stdinSecret?: string
  ): SpawnResult {
    const child = spawnChild(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: false })
    const session: LauncherSession = {
      kind: 'launcher',
      nodeId: request.nodeId,
      child,
      launched,
      buffer: '',
      flushTimer: null,
      pid: child.pid ?? 0,
      history: ''
    }
    this.track(session)

    if (stdinSecret && child.stdin) {
      // FreeRDP reads the password from stdin, keeping it out of the process list.
      child.stdin.write(`${stdinSecret}\n`)
      child.stdin.end()
    }

    let stderrSeen = 0
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrSeen >= MAX_LAUNCHER_STDERR) return
      stderrSeen += chunk.length
      this.queue(session, chunk.toString('utf8').replace(/\n/g, '\r\n'))
    })
    child.on('error', (error: Error) => {
      this.queue(session, `\r\n\x1b[31m${error.message}\x1b[0m\r\n`)
    })
    child.on('exit', (code) => {
      if (this.sessions.get(request.nodeId) !== session) return
      this.finish(session, code ?? 0)
    })

    return {
      nodeId: request.nodeId,
      pid: child.pid ?? 0,
      profileId: '',
      cwd: '',
      external: true,
      launched
    }
  }

  private track(session: Session): void {
    this.sessions.set(session.nodeId, session)
  }

  private describe(session: Session): SpawnResult {
    if (session.kind === 'pty') {
      return {
        nodeId: session.nodeId,
        pid: session.pid,
        profileId: session.profileId,
        cwd: session.cwd,
        replay: session.history
      }
    }
    if (session.kind === 'launcher') {
      return {
        nodeId: session.nodeId,
        pid: session.pid,
        profileId: '',
        cwd: '',
        external: true,
        launched: session.launched,
        replay: session.history
      }
    }
    if (session.kind === 'host') {
      return {
        nodeId: session.nodeId,
        pid: session.pid,
        profileId: session.profileId,
        cwd: session.cwd,
        replay: session.history
      }
    }
    return { nodeId: session.nodeId, pid: 0, profileId: '', cwd: '', replay: session.history }
  }

  private finish(session: Session, exitCode: number, signal?: number): void {
    this.flush(session)
    this.sessions.delete(session.nodeId)
    this.send('pty:exit', { nodeId: session.nodeId, exitCode, signal })
  }

  private queue(session: Session, data: string): void {
    session.history = `${session.history}${data}`.slice(-MAX_SESSION_REPLAY_CHARS)
    session.buffer += data
    if (session.buffer.length >= MAX_BUFFER_CHARS) {
      this.flush(session)
      return
    }
    if (!session.flushTimer) {
      session.flushTimer = setTimeout(() => this.flush(session), FLUSH_INTERVAL_MS)
    }
  }

  private flush(session: Session): void {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }
    if (!session.buffer) return
    const data = session.buffer
    session.buffer = ''
    this.send('pty:data', { nodeId: session.nodeId, data })
  }

  private async ensureHost(): Promise<Socket> {
    if (this.hostSocket && !this.hostSocket.destroyed) return this.hostSocket
    if (!this.hostScript) throw new Error('Detached session host is not configured')
    if (this.shuttingDown) throw new Error('TermTerm is closing')
    if (this.hostUnavailable) throw new Error('The detached session host is unavailable')

    const socket = await this.startHost()
    this.hostSocket = socket
    return socket
  }

  /**
   * Spawns a host on its own port and waits for a protocol handshake. Using a
   * port per run means a stale or frozen host left by an earlier build can never
   * be mistaken for this one; that produced "Session host did not respond" for
   * every terminal, with no way back short of killing the process by hand.
   */
  private async startHost(): Promise<Socket> {
    let lastError: Error = new Error('no response')

    for (let attempt = 0; attempt < HOST_START_ATTEMPTS; attempt += 1) {
      // An externally started host keeps the historical port unless told otherwise.
      const port =
        Number(process.env.TERMTERM_HOST_PORT) ||
        (process.env.TERMTERM_HOST_READY ? 45871 : await freePort())
      if (!process.env.TERMTERM_HOST_READY) {
        this.hostChild = spawnChild(process.execPath, [this.hostScript as string], {
          cwd: process.cwd(),
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TERMTERM_HOST_PORT: String(port) },
          shell: false
        })
        this.hostChild.unref()
      }

      const socket = await this.waitForHost(port).catch((error: Error) => {
        lastError = error
        return null
      })
      if (socket) {
        this.attachHost(socket)
        return socket
      }
      // Wrong protocol will not fix itself; only a bind failure is worth retrying.
      if (/protocol/.test(lastError.message)) break
      this.hostChild?.kill()
      this.hostChild = null
    }

    throw new Error(`The session host did not start: ${lastError.message}`)
  }

  private async waitForHost(port: number): Promise<Socket> {
    let lastError: Error = new Error('no response')
    for (let attempt = 0; attempt < HOST_READY_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, HOST_READY_INTERVAL_MS))
      let socket: Socket | null = null
      try {
        socket = await openSocket(port)
        const pong = await handshake(socket)
        if (pong.protocol !== HOST_PROTOCOL) {
          socket.destroy()
          throw new Error(`protocol ${pong.protocol ?? 'unknown'} does not match ${HOST_PROTOCOL}`)
        }
        return socket
      } catch (error) {
        socket?.destroy()
        lastError = error as Error
        if (/protocol/.test(lastError.message)) throw lastError
      }
    }
    throw lastError
  }

  private attachHost(socket: Socket): void {
    this.hostBuffer = ''
    socket.on('data', (chunk: Buffer) => {
      this.hostBuffer += chunk.toString('utf8')
      let newline = this.hostBuffer.indexOf('\n')
      while (newline >= 0) {
        const line = this.hostBuffer.slice(0, newline)
        this.hostBuffer = this.hostBuffer.slice(newline + 1)
        newline = this.hostBuffer.indexOf('\n')
        if (!line) continue
        try {
          const message = JSON.parse(line) as HostResponse
          if (message.type === 'data') {
            const session = this.sessions.get(message.nodeId ?? '')
            if (session) this.queue(session, message.data ?? '')
          } else if (message.type === 'exit') {
            const session = this.sessions.get(message.nodeId ?? '')
            // A replaced session must not report an exit for its successor.
            if (session && session.pid === message.pid) {
              this.finish(session, message.exitCode ?? 0, message.signal)
            }
          } else if (typeof message.requestId === 'number') {
            this.hostRequests.get(message.requestId)?.(message)
            this.hostRequests.delete(message.requestId)
          }
        } catch {
          // Ignore malformed host messages; the protocol is length-delimited JSON.
        }
      }
    })
    socket.on('close', () => {
      if (this.hostSocket === socket) this.hostSocket = null
      for (const resolve of this.hostRequests.values()) resolve({ type: 'error', message: 'Session host disconnected' })
      this.hostRequests.clear()
    })
  }

  private sendHost(message: Record<string, unknown>): void {
    void this.ensureHost()
      .then((socket) => socket.write(`${JSON.stringify(message)}\n`))
      .catch((error: unknown) => console.error('Detached session host error', error))
  }

  private async requestHost(message: Record<string, unknown>): Promise<HostResponse> {
    let lastError: Error = new Error('The session host did not respond')
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const socket = await this.ensureHost()
      try {
        return await this.writeHostRequest(socket, message)
      } catch (error) {
        lastError = error as Error
        // A host that stops answering is replaced rather than reused.
        this.resetHost()
      }
    }
    throw lastError
  }

  private writeHostRequest(socket: Socket, message: Record<string, unknown>): Promise<HostResponse> {
    const requestId = ++this.hostRequestId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.hostRequests.delete(requestId)
        reject(new Error('The session host did not respond'))
      }, HOST_REQUEST_TIMEOUT_MS)
      this.hostRequests.set(requestId, (response) => {
        clearTimeout(timer)
        resolve(response)
      })
      socket.write(`${JSON.stringify({ ...message, requestId })}\n`)
    })
  }

  private resetHost(): void {
    this.hostSocket?.destroy()
    this.hostSocket = null
    this.hostChild?.kill()
    this.hostChild = null
  }

  /** Stops the detached host so it cannot outlive the app as a stale listener. */
  shutdownHost(): void {
    this.shuttingDown = true
    const socket = this.hostSocket
    this.hostSocket = null
    if (socket && !socket.destroyed) {
      try {
        socket.write(`${JSON.stringify({ type: 'shutdown' })}\n`)
      } catch {
        // The socket can already be gone during quit.
      }
      socket.destroy()
    }
    this.hostChild?.kill()
    this.hostChild = null
  }
}
