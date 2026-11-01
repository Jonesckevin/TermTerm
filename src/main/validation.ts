import { isAbsolute } from 'node:path'
import type { ConnectionInput, ConnectionKind, SftpEntry, SpawnRequest } from '../shared/types'

export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidInputError'
  }
}

const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/
const HOSTNAME = /^[A-Za-z0-9._:[\]-]+$/
const USERNAME = /^[A-Za-z0-9._@\\-]+$/
const CONNECTION_KINDS: ConnectionKind[] = ['ssh', 'telnet', 'rdp']

/**
 * Every IPC argument crosses a trust boundary, so it is validated here rather than
 * assumed well-formed. Values ending up in spawn() argv must never be able to start
 * with "-", otherwise a crafted host would become an ssh option.
 */
export function assertNodeId(value: unknown): string {
  if (typeof value !== 'string' || !NODE_ID.test(value)) {
    throw new InvalidInputError('Invalid node id')
  }
  return value
}

export function assertTerminalData(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidInputError('Terminal data must be a string')
  if (value.length > 1024 * 1024) throw new InvalidInputError('Terminal data chunk too large')
  return value
}

export function assertDimension(value: unknown, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(1000, Math.floor(parsed)))
}

export function assertSpawnRequest(value: unknown): SpawnRequest {
  if (!value || typeof value !== 'object') throw new InvalidInputError('Invalid spawn request')
  const request = value as Record<string, unknown>
  const nodeId = assertNodeId(request.nodeId)
  const hasProfile = typeof request.profileId === 'string' && request.profileId.length > 0
  const hasConnection = typeof request.connectionId === 'string' && request.connectionId.length > 0
  if (hasProfile === hasConnection) {
    throw new InvalidInputError('Spawn request needs exactly one of profileId or connectionId')
  }

  return {
    nodeId,
    profileId: hasProfile ? (request.profileId as string).slice(0, 128) : undefined,
    connectionId: hasConnection ? (request.connectionId as string).slice(0, 128) : undefined,
    cwd: typeof request.cwd === 'string' && request.cwd.length > 0 ? request.cwd.slice(0, 4096) : undefined,
    cols: assertDimension(request.cols, 80),
    rows: assertDimension(request.rows, 24)
  }
}

export function assertMasterPassword(value: unknown): string {  if (typeof value !== 'string') throw new InvalidInputError('Password must be a string')
  if (value.length < 8) throw new InvalidInputError('Use at least 8 characters for the master password')
  if (value.length > 512) throw new InvalidInputError('Master password is too long')
  return value
}

export function assertConnectionInput(value: unknown): ConnectionInput {
  if (!value || typeof value !== 'object') throw new InvalidInputError('Invalid connection')
  const input = value as Record<string, unknown>

  const kind = input.kind
  if (typeof kind !== 'string' || !CONNECTION_KINDS.includes(kind as ConnectionKind)) {
    throw new InvalidInputError('Unsupported connection type')
  }

  const name = text(input.name, 64, 'name', true)
  const host = text(input.host, 255, 'host', true)
  if (!HOSTNAME.test(host) || host.startsWith('-')) throw new InvalidInputError('Host contains invalid characters')

  let port: number | undefined
  if (input.port !== undefined && input.port !== null && input.port !== '') {
    port = Number(input.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new InvalidInputError('Port must be 1-65535')
  }

  let username: string | undefined
  if (input.username !== undefined && input.username !== null && input.username !== '') {
    username = text(input.username, 64, 'username', false)
    if (!USERNAME.test(username) || username.startsWith('-')) {
      throw new InvalidInputError('Username contains invalid characters')
    }
  }

  let identityFile: string | undefined
  if (input.identityFile !== undefined && input.identityFile !== null && input.identityFile !== '') {
    identityFile = text(input.identityFile, 1024, 'identity file', false)
    if (identityFile.startsWith('-')) throw new InvalidInputError('Identity file path is not allowed')
  }

  let password: string | null | undefined
  if (input.password === null) {
    password = null
  } else if (typeof input.password === 'string' && input.password.length > 0) {
    if (input.password.length > 1024) throw new InvalidInputError('Password is too long')
    if (input.password.includes('\0')) throw new InvalidInputError('Password contains invalid characters')
    password = input.password
  }

  return {
    id: typeof input.id === 'string' && NODE_ID.test(input.id) ? input.id : undefined,
    name,
    kind: kind as ConnectionKind,
    host,
    port,
    username,
    identityFile,
    x11: input.x11 === true,
    x11Trusted: input.x11Trusted === true,
    password
  }
}

function text(value: unknown, max: number, field: string, required: boolean): string {
  if (value === undefined || value === null || value === '') {
    if (required) throw new InvalidInputError(`${field} is required`)
    return ''
  }
  if (typeof value !== 'string') throw new InvalidInputError(`${field} must be text`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw new InvalidInputError(`${field} is too long`)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new InvalidInputError(`${field} contains control characters`)
  return trimmed
}

/** Control characters would let a remote path smuggle a second line into a shell or log. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export function assertConnectionId(value: unknown): string {
  if (typeof value !== 'string' || !NODE_ID.test(value)) throw new InvalidInputError('Invalid connection id')
  return value
}

export function assertRemotePath(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidInputError('Remote path must be text')
  const path = value.trim()
  if (path.length === 0 || path.length > 4096) throw new InvalidInputError('Invalid remote path')
  if (CONTROL_CHARS.test(path)) throw new InvalidInputError('Remote path contains control characters')
  if (!path.startsWith('/')) throw new InvalidInputError('Remote paths must be absolute')
  return path
}

export function assertRemoteName(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidInputError('File name must be text')
  const name = value.trim()
  if (name.length === 0 || name.length > 255) throw new InvalidInputError('File names must be 1-255 characters')
  if (name === '.' || name === '..') throw new InvalidInputError('Invalid file name')
  if (name.includes('/') || CONTROL_CHARS.test(name)) {
    throw new InvalidInputError('File names cannot contain slashes or control characters')
  }
  return name
}

export function assertLocalPath(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidInputError('Local path must be text')
  const local = value.trim()
  if (local.length === 0 || local.length > 4096) throw new InvalidInputError('Invalid local path')
  if (CONTROL_CHARS.test(local)) throw new InvalidInputError('Local path contains control characters')
  if (!isAbsolute(local)) throw new InvalidInputError('Local paths must be absolute')
  return local
}

export function assertLocalPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new InvalidInputError('Choose at least one file')
  if (value.length > 50) throw new InvalidInputError('Upload at most 50 files at a time')
  return value.map((item) => assertLocalPath(item))
}

export function assertSftpKind(value: unknown): SftpEntry['kind'] {
  if (value === 'dir' || value === 'file' || value === 'link') return value
  throw new InvalidInputError('Invalid entry type')
}

export function assertFingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^SHA256:[A-Za-z0-9+/]{40,64}=?$/.test(value)) {
    throw new InvalidInputError('Invalid host key fingerprint')
  }
  return value
}
