import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ConnectionInput, ConnectionKind, SavedConnection, VaultStatus } from '../shared/types'

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }
const KEY_LENGTH = 32
const SALT_LENGTH = 16
const IV_LENGTH = 12
const MAX_VAULT_BYTES = 4 * 1024 * 1024
const CONNECTION_KINDS: ConnectionKind[] = ['ssh', 'telnet', 'rdp']

interface VaultFile {
  version: 1
  kdf: { name: 'scrypt'; salt: string; N: number; r: number; p: number }
  cipher: 'aes-256-gcm'
  iv: string
  tag: string
  data: string
}

interface StoredConnection extends Omit<SavedConnection, 'hasSecret'> {
  password?: string
}

interface VaultPayload {
  version: 1
  connections: StoredConnection[]
}

class VaultLockedError extends Error {
  constructor() {
    super('The vault is locked. Unlock it with your master password to continue.')
    this.name = 'VaultLockedError'
  }
}

export class InvalidPasswordError extends Error {
  constructor() {
    super('That master password did not unlock the vault.')
    this.name = 'InvalidPasswordError'
  }
}

export { VaultLockedError }

export class Vault {
  private key: Buffer | null = null
  private payload: VaultPayload | null = null

  constructor(private readonly filePath: string) {}

  status(): VaultStatus {
    return {
      exists: existsSync(this.filePath),
      unlocked: this.key !== null,
      connectionCount: this.payload?.connections.length ?? 0
    }
  }

  create(password: string): VaultStatus {
    if (existsSync(this.filePath)) throw new Error('A vault already exists.')
    const salt = randomBytes(SALT_LENGTH)
    this.key = deriveKey(password, salt, SCRYPT)
    this.payload = { version: 1, connections: [] }
    this.persist(salt)
    return this.status()
  }

  unlock(password: string): VaultStatus {
    if (!existsSync(this.filePath)) throw new Error('No vault has been created yet.')
    const file = this.read()
    const key = deriveKey(password, Buffer.from(file.kdf.salt, 'base64'), file.kdf)
    const plaintext = decrypt(file, key)
    // AES-GCM authentication is what actually proves the password was right.
    this.key = key
    this.payload = parsePayload(plaintext)
    return this.status()
  }

  lock(): VaultStatus {
    if (this.payload?.connections) {
      this.payload.connections.length = 0
    }
    if (this.key) this.key.fill(0)
    this.key = null
    this.payload = null
    return this.status()
  }

  isUnlocked(): boolean {
    return this.key !== null && this.payload !== null
  }

  connections(): SavedConnection[] {
    return (this.requirePayload().connections ?? []).map(toPublic)
  }

  secretFor(connectionId: string): string | undefined {
    const stored = this.requirePayload().connections.find((entry) => entry.id === connectionId)
    return stored?.password || undefined
  }

  connectionById(connectionId: string): SavedConnection | undefined {
    const stored = this.requirePayload().connections.find((entry) => entry.id === connectionId)
    return stored ? toPublic(stored) : undefined
  }

  upsert(input: ConnectionInput): SavedConnection[] {
    const payload = this.requirePayload()
    const existing = input.id ? payload.connections.find((entry) => entry.id === input.id) : undefined
    const id = existing?.id ?? randomId()
    const connection: StoredConnection = {
      id,
      name: input.name,
      kind: input.kind,
      host: input.host,
      port: input.port,
      username: input.username,
      identityFile: input.identityFile,
      x11: input.x11,
      x11Trusted: input.x11Trusted,
      badge: badgeFor(input),
      accent: accentFor(input.kind)
    }

    if (input.password === null) {
      // explicit clear
    } else if (typeof input.password === 'string' && input.password.length > 0) {
      connection.password = input.password
    } else if (existing?.password) {
      connection.password = existing.password
    }

    if (existing) {
      Object.assign(existing, connection)
      if (input.password === null) delete existing.password
    } else {
      payload.connections.push(connection)
    }
    this.persistCurrent()
    return this.connections()
  }

  remove(connectionId: string): SavedConnection[] {
    const payload = this.requirePayload()
    payload.connections = payload.connections.filter((entry) => entry.id !== connectionId)
    this.persistCurrent()
    return this.connections()
  }

  private requirePayload(): VaultPayload {
    if (!this.payload || !this.key) throw new VaultLockedError()
    return this.payload
  }

  private read(): VaultFile {
    const stat = readFileSync(this.filePath)
    if (stat.byteLength > MAX_VAULT_BYTES) throw new Error('Vault file is unexpectedly large; refusing to load.')
    const parsed = JSON.parse(stat.toString('utf8')) as VaultFile
    if (parsed.version !== 1 || parsed.cipher !== 'aes-256-gcm' || parsed.kdf?.name !== 'scrypt') {
      throw new Error('Unsupported vault format.')
    }
    return parsed
  }

  private persistCurrent(): void {
    if (!this.key) throw new VaultLockedError()
    const salt = Buffer.from(this.read().kdf.salt, 'base64')
    this.persist(salt)
  }

  private persist(salt: Buffer): void {
    if (!this.key || !this.payload) throw new VaultLockedError()
    const iv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const plaintext = Buffer.from(JSON.stringify(this.payload), 'utf8')
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const file: VaultFile = {
      version: 1,
      kdf: { name: 'scrypt', salt: salt.toString('base64'), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
      cipher: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: ciphertext.toString('base64')
    }
    plaintext.fill(0)

    mkdirSync(dirname(this.filePath), { recursive: true })
    const tempPath = `${this.filePath}.tmp`
    writeFileSync(tempPath, JSON.stringify(file), { encoding: 'utf8', mode: 0o600 })
    renameSync(tempPath, this.filePath)
    try {
      chmodSync(this.filePath, 0o600)
    } catch {
      // Windows has no POSIX mode bits; the vault is encrypted regardless.
    }
  }
}

function deriveKey(password: string, salt: Buffer, params: { N: number; r: number; p: number }): Buffer {
  return scryptSync(password, salt, KEY_LENGTH, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: Math.max(SCRYPT.maxmem, 128 * params.N * params.r * 2)
  })
}

function decrypt(file: VaultFile, key: Buffer): string {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(file.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new InvalidPasswordError()
  }
}

function parsePayload(plaintext: string): VaultPayload {
  const parsed = JSON.parse(plaintext) as VaultPayload
  return {
    version: 1,
    connections: Array.isArray(parsed.connections) ? parsed.connections.filter(isStoredConnection) : []
  }
}

function isStoredConnection(value: unknown): value is StoredConnection {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.id === 'string' &&
    typeof entry.name === 'string' &&
    typeof entry.host === 'string' &&
    CONNECTION_KINDS.includes(entry.kind as ConnectionKind)
  )
}

function toPublic(stored: StoredConnection): SavedConnection {
  const { password, ...rest } = stored
  return { ...rest, hasSecret: Boolean(password) }
}

function badgeFor(input: ConnectionInput): string {
  if (input.kind === 'telnet') return 'TN'
  if (input.kind === 'rdp') return 'RD'
  if (input.x11) return 'X11'
  return 'SSH'
}

function accentFor(kind: ConnectionKind): string {
  if (kind === 'telnet') return '#f59e0b'
  if (kind === 'rdp') return '#38bdf8'
  return '#22c55e'
}

function randomId(): string {
  return randomBytes(9).toString('base64url')
}

export function vaultPath(userDataDir: string): string {
  return join(userDataDir, 'vault.json')
}
