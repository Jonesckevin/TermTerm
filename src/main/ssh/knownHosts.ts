import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export interface KnownHostEntry {
  marker: '' | 'revoked' | 'cert-authority'
  /** Plain host patterns when the entry is not hashed. */
  patterns: string[]
  hashed: { salt: Buffer; digest: Buffer } | null
  keyType: string
  key: string
}

export interface KnownHostKey {
  keyType: string
  fingerprint: string
}

export type HostKeyVerdict =
  | { status: 'match'; keyType: string }
  | { status: 'unknown' }
  | { status: 'mismatch'; known: KnownHostKey[] }
  | { status: 'revoked' }

/** `Host` and `[host]:port` are the names OpenSSH will have written to known_hosts. */
export function hostNames(host: string, port: number): string[] {
  const bare = host.replace(/^\[(.*)\]$/, '$1')
  return port === 22 ? [bare] : [`[${bare}]:${port}`, bare]
}

export function parseKnownHosts(text: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = []

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue

    const parts = line.split(/\s+/)
    let marker: KnownHostEntry['marker'] = ''
    if (parts[0].startsWith('@')) {
      const value = parts.shift()?.slice(1)
      if (value !== 'revoked' && value !== 'cert-authority') continue
      marker = value
    }
    if (parts.length < 3) continue

    const [hostField, keyType, key] = parts
    if (!/^(ssh-|ecdsa-|sk-)/.test(keyType)) continue
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(key)) continue

    let hashed: KnownHostEntry['hashed'] = null
    let patterns: string[] = []
    if (hostField.startsWith('|1|')) {
      const [, , salt, digest] = hostField.split('|')
      const decodedSalt = salt ? Buffer.from(salt, 'base64') : undefined
      const decodedDigest = digest ? Buffer.from(digest, 'base64') : undefined
      if (!decodedSalt || !decodedDigest || decodedSalt.length === 0 || decodedDigest.length !== 20) continue
      hashed = { salt: decodedSalt, digest: decodedDigest }
    } else {
      patterns = hostField.split(',').filter((pattern) => pattern.length > 0)
      if (patterns.length === 0) continue
    }

    entries.push({ marker, patterns, hashed, keyType, key })
  }

  return entries
}

function patternMatches(pattern: string, name: string): boolean {
  if (pattern === name) return true
  if (!pattern.includes('*') && !pattern.includes('?')) return false
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`).test(name)
}

/** `!pattern` negations exclude a host even when a later pattern would match it. */
export function entryMatchesHost(entry: KnownHostEntry, names: string[]): boolean {
  if (entry.hashed) {
    return names.some((name) => {
      const digest = createHmac('sha1', entry.hashed!.salt).update(name).digest()
      return digest.length === entry.hashed!.digest.length && timingSafeEqual(digest, entry.hashed!.digest)
    })
  }

  let matched = false
  for (const pattern of entry.patterns) {
    const negated = pattern.startsWith('!')
    const body = negated ? pattern.slice(1) : pattern
    if (!names.some((name) => patternMatches(body, name))) continue
    if (negated) return false
    matched = true
  }
  return matched
}

/** The SSH host key blob starts with its algorithm name as a length-prefixed string. */
export function keyTypeOf(key: Buffer): string {
  try {
    const length = key.readUInt32BE(0)
    if (length <= 0 || length > 64 || length + 4 > key.length) return 'unknown'
    return key.subarray(4, 4 + length).toString('ascii')
  } catch {
    return 'unknown'
  }
}

/** OpenSSH-style `SHA256:<base64 without padding>`. */
export function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

export function verifyHostKey(text: string, host: string, port: number, key: Buffer): HostKeyVerdict {
  const names = hostNames(host, port)
  const keyBase64 = key.toString('base64')
  const entries = parseKnownHosts(text).filter(
    (entry) => entry.marker !== 'cert-authority' && entryMatchesHost(entry, names)
  )

  if (entries.some((entry) => entry.marker === 'revoked' && entry.key === keyBase64)) {
    return { status: 'revoked' }
  }
  if (entries.length === 0) return { status: 'unknown' }

  const match = entries.find((entry) => entry.marker === '' && entry.key === keyBase64)
  if (match) return { status: 'match', keyType: match.keyType }

  return {
    status: 'mismatch',
    known: entries
      .filter((entry) => entry.marker === '')
      .map((entry) => ({ keyType: entry.keyType, fingerprint: fingerprint(Buffer.from(entry.key, 'base64')) }))
  }
}

/** Line ready to append to a known_hosts file once the user accepts the key. */
export function knownHostsLine(host: string, port: number, key: Buffer): string {
  return `${hostNames(host, port)[0]} ${keyTypeOf(key)} ${key.toString('base64')}`
}
