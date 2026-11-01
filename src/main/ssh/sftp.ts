import { Client } from 'ssh2'
import type { Attributes, ConnectConfig, FileEntry, SFTPWrapper, Stats } from 'ssh2'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, isAbsolute } from 'node:path'
import type { SavedConnection, SftpEntry, SftpHostKeyChallenge, SftpListing, SftpUploadResult } from '../../shared/types'
import type { Vault } from '../vault'
import { fingerprint, keyTypeOf, knownHostsLine, verifyHostKey } from './knownHosts'
import type { HostKeyVerdict, KnownHostKey } from './knownHosts'

const IDLE_TIMEOUT_MS = 90_000
const MAX_TREE_DEPTH = 32
const DIRECTORY_MODE = 0o040000
const SYMLINK_MODE = 0o120000

export class HostKeyError extends Error {
  constructor(
    readonly verdict: 'unknown' | 'mismatch',
    readonly challenge: SftpHostKeyChallenge,
    message: string
  ) {
    super(message)
    this.name = 'HostKeyError'
  }
}

interface LiveClient {
  connectionId: string
  client: Client
  sftp: SFTPWrapper
  idle: NodeJS.Timeout | null
  home: string | null
}

export function joinRemote(directory: string, name: string): string {
  const base = directory === '/' ? '' : directory.replace(/\/+$/, '')
  return `${base}/${name}`
}

/** Lexical normalisation; the server still gets the final say on what a path means. */
export function normaliseRemote(input: string): string {
  const parts: string[] = []
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return parts.length === 0 ? '/' : `/${parts.join('/')}`
}

export function parentRemote(input: string): string {
  const normalised = normaliseRemote(input)
  if (normalised === '/') return '/'
  const index = normalised.lastIndexOf('/')
  return index <= 0 ? '/' : normalised.slice(0, index)
}

function expandHome(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(homedir(), input.slice(2))
  return input
}

function defaultPrivateKeys(): string[] {
  return ['id_ed25519', 'id_ecdsa', 'id_rsa']
    .map((name) => join(homedir(), '.ssh', name))
    .filter((candidate) => existsSync(candidate))
}

function isDirectory(stats: Attributes): boolean {
  return (stats.mode & 0o170000) === DIRECTORY_MODE
}

function wrap<T>(run: (done: (error: Error | undefined | null, value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    run((error, value) => (error ? reject(error) : resolve(value)))
  })
}

const readdir = (sftp: SFTPWrapper, path: string): Promise<FileEntry[]> => wrap((done) => sftp.readdir(path, done))
const statPath = (sftp: SFTPWrapper, path: string): Promise<Stats> => wrap((done) => sftp.stat(path, done))
const realpath = (sftp: SFTPWrapper, path: string): Promise<string> => wrap((done) => sftp.realpath(path, done))
const makeRemoteDirectory = (sftp: SFTPWrapper, path: string): Promise<void> =>
  wrap((done) => sftp.mkdir(path, (error) => done(error, undefined)))
const renameRemote = (sftp: SFTPWrapper, from: string, to: string): Promise<void> =>
  wrap((done) => sftp.rename(from, to, (error) => done(error, undefined)))
const unlinkRemote = (sftp: SFTPWrapper, path: string): Promise<void> =>
  wrap((done) => sftp.unlink(path, (error) => done(error, undefined)))
const removeRemoteDirectory = (sftp: SFTPWrapper, path: string): Promise<void> =>
  wrap((done) => sftp.rmdir(path, (error) => done(error, undefined)))
const getFile = (sftp: SFTPWrapper, remote: string, local: string): Promise<void> =>
  wrap((done) => sftp.fastGet(remote, local, (error) => done(error, undefined)))
const putFile = (sftp: SFTPWrapper, local: string, remote: string): Promise<void> =>
  wrap((done) => sftp.fastPut(local, remote, (error) => done(error, undefined)))

function toEntry(directory: string, item: FileEntry): SftpEntry {
  const mode = item.attrs.mode
  const kind = (mode & 0o170000) === DIRECTORY_MODE ? 'dir' : (mode & 0o170000) === SYMLINK_MODE ? 'link' : 'file'
  return {
    name: item.filename,
    path: joinRemote(directory, item.filename),
    kind,
    size: item.attrs.size ?? 0,
    modified: (item.attrs.mtime ?? 0) * 1000
  }
}

/**
 * SFTP sessions live in the main process and never expose credentials to the
 * renderer: the UI only ever names a connection id.
 */
export class SftpService {
  private readonly clients = new Map<string, LiveClient>()
  private readonly connecting = new Map<string, Promise<LiveClient>>()
  private readonly pendingHostKeys = new Map<string, { fingerprint: string; line: string }>()

  constructor(
    private readonly vault: Vault,
    /** Written only after the user accepts a key. */
    private readonly trustedHostsFile: string,
    /** Existing OpenSSH known_hosts files, read-only. */
    private readonly userKnownHostsFiles: string[]
  ) {}

  async list(connectionId: string, requestedPath?: string): Promise<SftpListing> {
    return this.run(connectionId, async (live) => {
      const home = await this.homeFor(live)
      const target = requestedPath ? normaliseRemote(requestedPath) : home
      const items = await readdir(live.sftp, target)
      const entries = items
        .filter((item) => item.filename !== '.' && item.filename !== '..')
        .map((item) => toEntry(target, item))
        .sort((left, right) => {
          if (left.kind === 'dir' && right.kind !== 'dir') return -1
          if (right.kind === 'dir' && left.kind !== 'dir') return 1
          return left.name.localeCompare(right.name, 'en', { numeric: true, sensitivity: 'base' })
        })
      return { path: target, home, entries }
    })
  }

  async stat(connectionId: string, remotePath: string): Promise<SftpEntry> {
    return this.run(connectionId, async (live) => {
      const target = normaliseRemote(remotePath)
      const stats = await statPath(live.sftp, target)
      return {
        name: basename(target),
        path: target,
        kind: isDirectory(stats) ? 'dir' : 'file',
        size: stats.size ?? 0,
        modified: (stats.mtime ?? 0) * 1000
      }
    })
  }

  async makeDirectory(connectionId: string, remoteDirectory: string, name: string): Promise<string> {
    return this.run(connectionId, async (live) => {
      const target = joinRemote(normaliseRemote(remoteDirectory), name)
      await makeRemoteDirectory(live.sftp, target)
      return target
    })
  }

  async rename(connectionId: string, remotePath: string, newName: string): Promise<string> {
    return this.run(connectionId, async (live) => {
      const from = normaliseRemote(remotePath)
      if (from === '/') throw new Error('The root folder cannot be renamed')
      const to = joinRemote(parentRemote(from), newName)
      await renameRemote(live.sftp, from, to)
      return to
    })
  }

  async remove(connectionId: string, remotePath: string, kind: 'dir' | 'file' | 'link'): Promise<number> {
    return this.run(connectionId, async (live) => {
      const target = normaliseRemote(remotePath)
      if (target === '/') throw new Error('The root folder cannot be deleted')
      if (kind !== 'dir') {
        await unlinkRemote(live.sftp, target)
        return 1
      }
      return this.removeTree(live.sftp, target, 0)
    })
  }

  async download(connectionId: string, remotePath: string, localPath: string): Promise<{ path: string; size: number }> {
    return this.run(connectionId, async (live) => {
      const target = normaliseRemote(remotePath)
      const stats = await statPath(live.sftp, target)
      if (isDirectory(stats)) throw new Error('That is a folder – open it and download the files inside.')
      if (!isAbsolute(localPath)) throw new Error('Choose a local file path')
      mkdirSync(dirname(localPath), { recursive: true })
      await getFile(live.sftp, target, localPath)
      return { path: localPath, size: statSync(localPath).size }
    })
  }

  async upload(connectionId: string, remoteDirectory: string, localPaths: string[]): Promise<SftpUploadResult> {
    return this.run(connectionId, async (live) => {
      const directory = normaliseRemote(remoteDirectory)
      const uploaded: { name: string; size: number }[] = []
      for (const localPath of localPaths) {
        const info = statSync(localPath)
        if (!info.isFile()) throw new Error(`${basename(localPath)} is not a file`)
        await putFile(live.sftp, localPath, joinRemote(directory, basename(localPath)))
        uploaded.push({ name: basename(localPath), size: info.size })
      }
      return { directory, uploaded }
    })
  }

  /** Accepts a host key the UI has just shown to the user. */
  trustHost(connectionId: string, shownFingerprint: string): void {
    const pending = this.pendingHostKeys.get(connectionId)
    if (!pending) throw new Error('There is no host key waiting for approval. Retry the connection.')
    if (pending.fingerprint !== shownFingerprint) {
      throw new Error('The host key changed while you were reviewing it. Retry the connection.')
    }
    mkdirSync(dirname(this.trustedHostsFile), { recursive: true })
    appendFileSync(this.trustedHostsFile, `${pending.line}\n`, { mode: 0o600 })
    this.pendingHostKeys.delete(connectionId)
  }

  disconnect(connectionId: string): void {
    const live = this.clients.get(connectionId)
    if (!live) return
    this.clients.delete(connectionId)
    if (live.idle) clearTimeout(live.idle)
    try {
      live.client.end()
    } catch {
      // already closed
    }
  }

  disconnectAll(): void {
    for (const connectionId of [...this.clients.keys()]) this.disconnect(connectionId)
    this.pendingHostKeys.clear()
  }

  private async removeTree(sftp: SFTPWrapper, path: string, depth: number): Promise<number> {
    if (depth > MAX_TREE_DEPTH) throw new Error('That folder is nested too deeply to delete safely.')
    const items = (await readdir(sftp, path)).filter((item) => item.filename !== '.' && item.filename !== '..')
    let removed = 0
    for (const item of items) {
      const child = joinRemote(path, item.filename)
      if (isDirectory(item.attrs)) removed += await this.removeTree(sftp, child, depth + 1)
      else {
        await unlinkRemote(sftp, child)
        removed += 1
      }
    }
    await removeRemoteDirectory(sftp, path)
    return removed + 1
  }

  private knownHostsText(): string {
    const files = [this.trustedHostsFile, ...this.userKnownHostsFiles]
    return files
      .filter((file) => existsSync(file))
      .map((file) => {
        try {
          return readFileSync(file, 'utf8')
        } catch {
          return ''
        }
      })
      .join('\n')
  }

  private async run<T>(connectionId: string, action: (live: LiveClient) => Promise<T>): Promise<T> {
    const live = await this.session(connectionId)
    this.touch(live)
    try {
      return await action(live)
    } catch (error) {
      // A dropped connection must not be reused for the next request.
      if (isConnectionLoss(error)) this.disconnect(connectionId)
      throw error
    }
  }

  private async homeFor(live: LiveClient): Promise<string> {
    if (!live.home) live.home = await realpath(live.sftp, '.')
    return live.home
  }

  private touch(live: LiveClient): void {
    if (live.idle) clearTimeout(live.idle)
    live.idle = setTimeout(() => this.disconnect(live.connectionId), IDLE_TIMEOUT_MS)
    live.idle.unref?.()
  }

  private async session(connectionId: string): Promise<LiveClient> {
    // A cached session must not outlive the vault: the credentials it holds were
    // only usable while unlocked.
    if (!this.vault.isUnlocked()) throw new Error('Unlock the vault to browse files.')

    const cached = this.clients.get(connectionId)
    if (cached) return cached

    const inFlight = this.connecting.get(connectionId)
    if (inFlight) return inFlight

    const attempt = this.open(connectionId).finally(() => this.connecting.delete(connectionId))
    this.connecting.set(connectionId, attempt)
    const live = await attempt
    this.clients.set(connectionId, live)
    this.touch(live)
    return live
  }

  private async open(connectionId: string): Promise<LiveClient> {
    const connection = this.vault.connectionById(connectionId)
    if (!connection) throw new Error('That connection is no longer in the vault')
    if (connection.kind !== 'ssh') throw new Error('File browsing needs an SSH connection.')
    const secret = this.vault.secretFor(connectionId)

    const base: ConnectConfig = {
      host: connection.host,
      port: connection.port ?? 22,
      username: connection.username || undefined,
      readyTimeout: 20_000,
      keepaliveInterval: 20_000,
      keepaliveCountMax: 3,
      tryKeyboard: Boolean(secret)
    }

    const attempts: ConnectConfig[] = []
    const identityFile = connection.identityFile ? expandHome(connection.identityFile) : ''
    if (identityFile) {
      if (!existsSync(identityFile)) throw new Error(`Identity file not found: ${identityFile}`)
      attempts.push({
        ...base,
        privateKey: readFileSync(identityFile),
        ...(secret ? { passphrase: secret } : {})
      })
    }
    if (process.env.SSH_AUTH_SOCK) attempts.push({ ...base, agent: process.env.SSH_AUTH_SOCK })
    for (const keyPath of defaultPrivateKeys()) {
      if (keyPath === identityFile) continue
      attempts.push({ ...base, privateKey: readFileSync(keyPath), ...(secret ? { passphrase: secret } : {}) })
    }
    if (secret) attempts.push({ ...base, password: secret })

    if (attempts.length === 0) {
      throw new Error('No credentials available. Add an identity file or a password to this connection.')
    }

    let lastError: unknown = null
    for (const config of attempts) {
      try {
        return await this.connect(connectionId, connection, config, secret)
      } catch (error) {
        // Host key problems apply to the host, not the credential: never retry them.
        if (error instanceof HostKeyError) throw error
        lastError = error
      }
    }

    const detail = lastError instanceof Error ? lastError.message : String(lastError)
    throw new Error(
      `${connection.username || 'The user'} could not authenticate to ${connection.host}:${base.port} – ${detail}`
    )
  }

  private connect(
    connectionId: string,
    connection: SavedConnection,
    config: ConnectConfig,
    secret: string | undefined
  ): Promise<LiveClient> {
    const port = config.port ?? 22
    return new Promise<LiveClient>((resolve, reject) => {
      const client = new Client()
      let verdict: HostKeyVerdict | null = null
      let hostKey: Buffer | null = null
      let settled = false

      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        try {
          client.end()
        } catch {
          // already closed
        }
        reject(error)
      }

      client.on('ready', () => {
        client.sftp((error, sftp) => {
          if (settled) return
          if (error || !sftp) {
            fail(error ?? new Error('This server did not start an SFTP subsystem.'))
            return
          }
          settled = true
          const live: LiveClient = { connectionId, client, sftp, idle: null, home: null }
          client.on('close', () => {
            if (this.clients.get(connectionId) === live) this.clients.delete(connectionId)
          })
          resolve(live)
        })
      })

      client.on('keyboard-interactive', (_name, _instructions, _language, prompts, finish) => {
        finish(prompts.map(() => secret ?? ''))
      })

      client.on('error', (error) => {
        if (!hostKey) {
          fail(error)
          return
        }
        const challenge: SftpHostKeyChallenge = {
          host: connection.host,
          keyType: keyTypeOf(hostKey),
          fingerprint: fingerprint(hostKey)
        }
        if (verdict?.status === 'unknown') {
          this.pendingHostKeys.set(connectionId, {
            fingerprint: challenge.fingerprint,
            line: knownHostsLine(connection.host, port, hostKey)
          })
          fail(new HostKeyError('unknown', challenge, `The host key for ${connection.host} is not trusted yet.`))
          return
        }
        if (verdict?.status === 'mismatch') {
          const known = (verdict as { known: KnownHostKey[] }).known
          fail(
            new HostKeyError(
              'mismatch',
              challenge,
              `Host key verification failed for ${connection.host}. The server offered ${challenge.keyType} ${challenge.fingerprint}, ` +
                `but known_hosts has ${known.map((key) => `${key.keyType} ${key.fingerprint}`).join(', ') || 'a different key'}. ` +
                'This can mean a man-in-the-middle attack; check the host before continuing.'
            )
          )
          return
        }
        if (verdict?.status === 'revoked') {
          fail(new Error(`The host key offered by ${connection.host} is marked @revoked in known_hosts.`))
          return
        }
        fail(error)
      })

      client.connect({
        ...config,
        hostVerifier: (key: Buffer) => {
          hostKey = key
          verdict = verifyHostKey(this.knownHostsText(), connection.host, port, key)
          return verdict.status === 'match'
        }
      })
    })
  }
}

function isConnectionLoss(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  return /not connected|no response from server|connection lost|channel closed|timed out/.test(message)
}
