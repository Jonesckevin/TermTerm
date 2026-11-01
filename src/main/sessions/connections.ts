import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { SavedConnection, X11Status } from '../../shared/types'

export type SessionSpec =
  | { transport: 'pty'; file: string; args: string[]; cwd?: string; warning?: string }
  | { transport: 'socket'; host: string; port: number }
  | { transport: 'launcher'; file: string; args: string[]; stdinSecret?: string; launched: string }

function findOnPath(command: string): string | null {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
      windowsHide: true
    })
    const first = out
      .toString('utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && existsSync(line))
    return first ?? null
  } catch {
    return null
  }
}

function sshBinary(): string {
  if (process.platform !== 'win32') return 'ssh'
  return findOnPath('ssh.exe') ?? 'ssh.exe'
}

export function buildConnectionSpec(
  connection: SavedConnection,
  secret: string | undefined,
  x11: X11Status
): SessionSpec {
  if (connection.kind === 'telnet') {
    return { transport: 'socket', host: connection.host, port: connection.port ?? 23 }
  }

  if (connection.kind === 'rdp') {
    return buildRdpSpec(connection, secret)
  }

  const args: string[] = ['-t']
  if (connection.port) args.push('-p', String(connection.port))
  if (connection.identityFile) args.push('-i', connection.identityFile)
  if (connection.x11) args.push(connection.x11Trusted ? '-Y' : '-X')
  args.push('-o', 'ServerAliveInterval=30')
  args.push(connection.username ? `${connection.username}@${connection.host}` : connection.host)

  const warning =
    connection.x11 && !x11.available
      ? `X11 forwarding requested but no X server is available: ${x11.detail}`
      : undefined

  return { transport: 'pty', file: sshBinary(), args, warning }
}

function buildRdpSpec(connection: SavedConnection, secret: string | undefined): SessionSpec {
  const endpoint = connection.port ? `${connection.host}:${connection.port}` : connection.host

  if (process.platform === 'win32') {
    // mstsc prompts for credentials itself, so no secret is ever handed to it.
    return {
      transport: 'launcher',
      file: 'mstsc.exe',
      args: [`/v:${endpoint}`],
      launched: `mstsc.exe /v:${endpoint}`
    }
  }

  if (process.platform === 'linux') {
    const client = findOnPath('xfreerdp') ?? findOnPath('xfreerdp3') ?? findOnPath('wlfreerdp')
    if (!client) {
      throw new Error('FreeRDP is not installed. Install xfreerdp to open RDP sessions on Linux.')
    }
    const args = [`/v:${endpoint}`, '/cert:tofu', '/dynamic-resolution']
    if (connection.username) args.push(`/u:${connection.username}`)
    if (secret) args.push('/from-stdin')
    return {
      transport: 'launcher',
      file: client,
      args,
      stdinSecret: secret,
      launched: `${client.split('/').pop()} ${args.join(' ')}`
    }
  }

  return {
    transport: 'launcher',
    file: 'open',
    args: ['-a', 'Microsoft Remote Desktop', `rdp://${endpoint}`],
    launched: `Microsoft Remote Desktop → ${endpoint}`
  }
}
