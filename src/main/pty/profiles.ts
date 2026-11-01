import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { ShellProfile } from '../../shared/types'
import { containerExecSpec, listContainerProfiles, parseContainerProfileId } from '../containers'
import { decodeOutput, findOnPath, firstExisting, runCapture } from '../exec'

export interface SpawnSpec {
  file: string
  args: string[]
  cwd?: string
}

const WINDOWS_DISTRO_COLORS: Record<string, { badge: string; accent: string; name: string }> = {
  ubuntu: { badge: 'UB', accent: '#e95420', name: 'Ubuntu' },
  kali: { badge: 'KA', accent: '#5aa9e6', name: 'Kali Linux' },
  debian: { badge: 'DE', accent: '#d70a53', name: 'Debian' },
  fedora: { badge: 'FE', accent: '#3c6eb4', name: 'Fedora' },
  arch: { badge: 'AR', accent: '#1793d1', name: 'Arch Linux' },
  alpine: { badge: 'AL', accent: '#0d597f', name: 'Alpine' },
  opensuse: { badge: 'SU', accent: '#73ba25', name: 'openSUSE' },
  'docker-desktop': { badge: 'DK', accent: '#2496ed', name: 'Docker Desktop' }
}

const POSIX_ACCENTS: Record<string, string> = {
  sh: '#9ca3af',
  dash: '#d1a04a',
  ksh: '#e07a5f',
  tmux: '#4ade80',
  screen: '#8fb339'
}

/** Arguments for generic shells; anything else gets `-l`. */
const SHELL_ARGS: Record<string, string[]> = {
  nu: [],
  tmux: [],
  screen: []
}

/** The executable an existing profile points at, if it is still on disk. */
function exeOf(profile: ShellProfile): string | null {
  return profile.detail && existsSync(profile.detail) ? profile.detail : null
}

function localAppData(): string {
  return process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
}

function windowsSystemRoot(): string {
  return process.env.SystemRoot ?? 'C:\\Windows'
}

export interface WindowsShellCandidate {
  id: string
  name: string
  badge: string
  accent: string
  kind: ShellProfile['kind']
  /** Executable names probed on PATH, in order. */
  probes: string[]
  /** Explicit install locations, tried after the PATH probe. */
  paths: string[]
}

/**
 * Every Windows shell we know how to launch, independent of what is installed.
 * Kept as data so the table can be unit-tested without those tools present.
 */
export function windowsShellCandidates(): WindowsShellCandidate[] {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const local = localAppData()
  const home = homedir()

  return [
    {
      id: 'pwsh7',
      name: 'PowerShell 7',
      badge: 'P7',
      accent: '#5391fe',
      kind: 'powershell',
      probes: ['pwsh.exe'],
      paths: [
        join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
        join(local, 'Microsoft', 'WindowsApps', 'pwsh.exe'),
        join(home, 'scoop', 'shims', 'pwsh.exe')
      ]
    },
    {
      id: 'pwsh-preview',
      name: 'PowerShell 7 Preview',
      badge: 'P7p',
      accent: '#7aa8ff',
      kind: 'powershell',
      probes: ['pwsh-preview.exe'],
      paths: [
        join(programFiles, 'PowerShell', '7-preview', 'pwsh.exe'),
        join(home, 'scoop', 'shims', 'pwsh-preview.exe')
      ]
    },
    {
      id: 'powershell',
      name: 'Windows PowerShell 5.1',
      badge: 'P5',
      accent: '#7b9cd4',
      kind: 'powershell',
      probes: [],
      paths: [join(windowsSystemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]
    },
    {
      id: 'cmd',
      name: 'Command Prompt',
      badge: 'C:',
      accent: '#c9c9cf',
      kind: 'cmd',
      probes: [],
      paths: [process.env.ComSpec ?? join(windowsSystemRoot(), 'System32', 'cmd.exe')]
    },
    {
      id: 'gitbash',
      name: 'Git Bash',
      badge: 'GB',
      accent: '#f14e32',
      kind: 'unix',
      // Deliberately no `where bash.exe`: on machines without Git that resolves to
      // System32\bash.exe, which is the WSL launcher, not Git Bash.
      probes: [],
      paths: [
        join(programFiles, 'Git', 'bin', 'bash.exe'),
        join(programFilesX86, 'Git', 'bin', 'bash.exe'),
        join(local, 'Programs', 'Git', 'bin', 'bash.exe'),
        join(home, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
        join(home, 'scoop', 'shims', 'bash.exe')
      ]
    },
    {
      id: 'msys2',
      name: 'MSYS2 Bash',
      badge: 'MS',
      accent: '#a855f7',
      kind: 'unix',
      probes: [],
      paths: [
        'C:\\msys64\\usr\\bin\\bash.exe',
        'C:\\msys64\\ucrt64\\bin\\bash.exe',
        'C:\\msys64\\mingw64\\bin\\bash.exe',
        join(home, 'scoop', 'apps', 'msys2', 'current', 'usr', 'bin', 'bash.exe')
      ]
    },
    {
      id: 'cygwin',
      name: 'Cygwin Bash',
      badge: 'CY',
      accent: '#0e8f5a',
      kind: 'unix',
      probes: [],
      paths: ['C:\\cygwin64\\bin\\bash.exe', 'C:\\cygwin\\bin\\bash.exe']
    },
    {
      id: 'nu',
      name: 'Nushell',
      badge: 'NU',
      accent: '#4ade80',
      kind: 'shell',
      probes: ['nu.exe'],
      paths: [
        join(programFiles, 'Nu', 'bin', 'nu.exe'),
        join(local, 'Microsoft', 'WindowsApps', 'nu.exe'),
        join(home, 'scoop', 'shims', 'nu.exe'),
        join(home, '.cargo', 'bin', 'nu.exe')
      ]
    }
  ]
}

export interface SshHostSettings {
  user?: string
  port?: number
  identityFile?: string
}

/** Parses the parts of an ssh_config we surface: Host blocks and their user/port/key. */
export function parseSshConfig(text: string): Map<string, SshHostSettings> {
  const hosts = new Map<string, SshHostSettings>()
  let currentHosts: string[] = []

  const assign = (host: string, key: keyof SshHostSettings, value: string | number): void => {
    const entry = hosts.get(host) ?? {}
    // ssh applies the first value it sees for a host.
    if (entry[key] === undefined) (entry as Record<string, unknown>)[key] = value
    hosts.set(host, entry)
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const [keywordRaw, ...rest] = line.split(/\s+/)
    const keyword = keywordRaw.toLowerCase()
    const value = rest.join(' ')

    if (keyword === 'host') {
      currentHosts = value.split(/\s+/).filter((host) => host.length > 0 && !/[*?!]/.test(host))
      for (const host of currentHosts) if (!hosts.has(host)) hosts.set(host, {})
      continue
    }
    if (currentHosts.length === 0) continue

    for (const host of currentHosts) {
      if (keyword === 'user' && value) assign(host, 'user', value)
      else if (keyword === 'port' && /^\d+$/.test(value)) assign(host, 'port', Number(value))
      else if (keyword === 'identityfile' && value) {
        assign(host, 'identityFile', expandHome(value.replace(/^"(.*)"$/, '$1')))
      }
    }
  }

  return hosts
}

function expandHome(value: string): string {
  return value.replace(/^~(?=$|[\\/])/, homedir())
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function expandSshInclude(pattern: string): string[] {
  const expanded = expandHome(pattern)
  const target = isAbsolute(expanded) ? expanded : join(homedir(), '.ssh', expanded)
  const name = basename(target)
  if (!name.includes('*')) return [target]
  try {
    const matcher = new RegExp(`^${name.split('*').map(escapeRegExp).join('.*')}$`)
    return readdirSync(dirname(target))
      .filter((entry) => matcher.test(entry))
      .sort()
      .map((entry) => join(dirname(target), entry))
  } catch {
    return []
  }
}

function readSshConfigText(path: string, depth: number, seen: Set<string>): string {
  if (depth > 8 || seen.has(path) || !existsSync(path)) return ''
  seen.add(path)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return ''
  }

  let combined = ''
  for (const rawLine of text.split(/\r?\n/)) {
    const include = /^\s*include\s+(.+)$/i.exec(rawLine.replace(/#.*$/, ''))
    if (!include) {
      combined += `${rawLine}\n`
      continue
    }
    for (const pattern of include[1].trim().split(/\s+/)) {
      for (const file of expandSshInclude(pattern)) combined += readSshConfigText(file, depth + 1, seen)
    }
  }
  return combined
}

function readSshHosts(): Map<string, SshHostSettings> {
  return parseSshConfig(readSshConfigText(join(homedir(), '.ssh', 'config'), 0, new Set()))
}

function readWslDistros(): string[] {
  const out = runCapture('wsl.exe', ['--list', '--quiet'])
  if (!out) return []
  return decodeOutput(out)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^wsl/i.test(line))
}

/** Canonical shell list on POSIX; surfaces extras such as dash, ksh and tmux. */
export function readEtcShells(): string[] {
  try {
    return readFileSync('/etc/shells', 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#') && existsSync(line))
  } catch {
    return []
  }
}

function windowsProfiles(): ShellProfile[] {
  const profiles: ShellProfile[] = windowsShellCandidates().map((candidate) => {
    const probed = candidate.probes.map((exe) => findOnPath(exe)).find((found) => Boolean(found)) ?? null
    const found = probed ?? firstExisting(candidate.paths)
    return {
      id: candidate.id,
      name: candidate.name,
      kind: candidate.kind,
      badge: candidate.badge,
      accent: candidate.accent,
      detail: found ?? 'not installed',
      available: Boolean(found)
    }
  })

  for (const distro of readWslDistros()) {
    const key = distro.toLowerCase().split('-')[0]
    const style = WINDOWS_DISTRO_COLORS[key] ?? WINDOWS_DISTRO_COLORS[distro.toLowerCase()]
    profiles.push({
      id: `wsl:${distro}`,
      name: `${style?.name ?? distro} (WSL)`,
      kind: 'wsl',
      badge: style?.badge ?? distro.slice(0, 2).toUpperCase(),
      accent: style?.accent ?? '#4ea1d3',
      detail: `wsl.exe -d ${distro}`,
      available: true
    })
  }

  for (const [host, settings] of readSshHosts()) {
    const target = settings.user ? `${settings.user}@${host}` : host
    const port = settings.port ? `:${settings.port}` : ''
    const key = settings.identityFile ? ` · ${basename(settings.identityFile)}` : ''
    profiles.push({
      id: `ssh:${host}`,
      name: `ssh ${host}`,
      kind: 'ssh',
      badge: 'SSH',
      accent: '#22c55e',
      detail: `${target}${port}${key}`,
      available: true
    })
  }

  return profiles
}

const POSIX_SHELLS: Array<{ id: string; name: string; badge: string; accent: string; paths: string[] }> = [
  {
    id: 'zsh',
    name: 'zsh',
    badge: 'ZS',
    accent: '#f9d423',
    paths: ['/bin/zsh', '/usr/bin/zsh', '/opt/homebrew/bin/zsh']
  },
  { id: 'bash', name: 'bash', badge: 'BA', accent: '#4eaa25', paths: ['/bin/bash', '/usr/bin/bash'] },
  {
    id: 'fish',
    name: 'fish',
    badge: 'FI',
    accent: '#8b5cf6',
    paths: ['/usr/bin/fish', '/usr/local/bin/fish', '/opt/homebrew/bin/fish']
  },
  {
    id: 'nu',
    name: 'nu',
    badge: 'NU',
    accent: '#4ade80',
    paths: ['/usr/bin/nu', '/usr/local/bin/nu', '/opt/homebrew/bin/nu']
  }
]

function posixProfiles(): ShellProfile[] {
  const defaultShell = process.env.SHELL ?? ''
  const defaultName = defaultShell ? basename(defaultShell) : ''

  const profiles: ShellProfile[] = POSIX_SHELLS.map((candidate) => {
    const found = firstExisting(candidate.paths) ?? findOnPath(candidate.id)
    return {
      id: candidate.id,
      name: candidate.name,
      kind: 'unix',
      badge: candidate.badge,
      accent: candidate.accent,
      detail: found ?? 'not installed',
      isDefault: Boolean(found && defaultName === basename(found)),
      available: Boolean(found)
    }
  })

  // /etc/shells is the canonical list, so anything else the system accepts shows up.
  const known = new Set(POSIX_SHELLS.map((candidate) => candidate.name))
  const seen = new Set<string>()
  for (const path of readEtcShells()) {
    const name = basename(path)
    if (known.has(name) || seen.has(name)) continue
    seen.add(name)
    profiles.push({
      id: `posix:${path}`,
      name,
      kind: 'shell',
      badge: name.slice(0, 2).toUpperCase(),
      accent: POSIX_ACCENTS[name] ?? '#8b8b96',
      detail: path,
      isDefault: defaultName === name,
      available: true
    })
  }

  return profiles
}

export function listProfiles(): ShellProfile[] {
  const detected = process.platform === 'win32' ? windowsProfiles() : posixProfiles()
  // Running containers are shells too, so they ride along in the command palette.
  return [...detected, ...listContainerProfiles(), ...customProfiles()].filter((profile) => profile.available)
}

interface CustomProfileFileEntry {
  name: string
  command: string
  args?: string[]
  cwd?: string
  badge?: string
  accent?: string
}

let customCache: ShellProfile[] | null = null
let customPath: string | null = null

export function setCustomProfilesPath(path: string): void {
  customPath = path
  customCache = null
}

function customProfiles(): ShellProfile[] {
  if (customCache) return customCache
  customCache = []
  if (!customPath || !existsSync(customPath)) return customCache
  try {
    const parsed = JSON.parse(readFileSync(customPath, 'utf8')) as
      | CustomProfileFileEntry[]
      | { profiles?: CustomProfileFileEntry[] }
    const entries = Array.isArray(parsed) ? parsed : (parsed.profiles ?? [])
    customCache = entries
      .filter((entry) => entry && typeof entry.command === 'string' && entry.command.length > 0)
      .map((entry, index) => ({
        id: `custom:${index}:${entry.name}`,
        name: entry.name || entry.command,
        kind: 'custom' as const,
        badge: entry.badge ?? '>_',
        accent: entry.accent ?? '#ff6d5a',
        detail: [entry.command, ...(entry.args ?? [])].join(' '),
        available: true
      }))
  } catch {
    // A malformed profiles.json should never block startup.
  }
  return customCache
}

function customEntryFor(profileId: string): CustomProfileFileEntry | null {
  if (!customPath || !existsSync(customPath) || !profileId.startsWith('custom:')) return null
  try {
    const parsed = JSON.parse(readFileSync(customPath, 'utf8')) as
      | CustomProfileFileEntry[]
      | { profiles?: CustomProfileFileEntry[] }
    const entries = Array.isArray(parsed) ? parsed : (parsed.profiles ?? [])
    const index = Number(profileId.split(':')[1])
    return Number.isInteger(index) ? (entries[index] ?? null) : null
  } catch {
    return null
  }
}

export function buildSpawnSpec(profile: ShellProfile, cwd?: string): SpawnSpec {
  const workdir = cwd && existsSync(cwd) ? cwd : homedir()
  const isWindows = process.platform === 'win32'

  if (profile.kind === 'custom') {
    const entry = customEntryFor(profile.id)
    if (entry) {
      return { file: entry.command, args: entry.args ?? [], cwd: entry.cwd ?? workdir }
    }
    return { file: isWindows ? 'cmd.exe' : '/bin/bash', args: [], cwd: workdir }
  }

  if (profile.kind === 'wsl') {
    const distro = profile.id.slice('wsl:'.length)
    // wsl.exe otherwise inherits (and translates) the Windows process cwd.
    const startDir = cwd && existsSync(cwd) ? cwd : '~'
    return { file: 'wsl.exe', args: ['-d', distro, '--cd', startDir] }
  }

  if (profile.kind === 'ssh') {
    const host = profile.id.slice('ssh:'.length)
    return { file: isWindows ? 'ssh.exe' : 'ssh', args: ['-t', host] }
  }

  if (profile.kind === 'cmd') {
    return { file: process.env.ComSpec ?? 'cmd.exe', args: [], cwd: workdir }
  }

  if (profile.kind === 'powershell') {
    const fallback =
      profile.id === 'pwsh-preview'
        ? 'pwsh-preview.exe'
        : profile.id === 'pwsh7'
          ? (findOnPath('pwsh.exe') ?? 'pwsh.exe')
          : (firstExisting([
              join(windowsSystemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
            ]) ?? 'powershell.exe')
    return { file: exeOf(profile) ?? fallback, args: ['-NoLogo'], cwd: workdir }
  }

  if (profile.kind === 'shell') {
    const exe = exeOf(profile)
    if (!exe) throw new Error(`${profile.name} is no longer installed`)
    const name = basename(exe).toLowerCase()
    return { file: exe, args: SHELL_ARGS[name] ?? ['-l'], cwd: workdir }
  }

  if (profile.kind === 'container') {
    const parsed = parseContainerProfileId(profile.id)
    if (!parsed) throw new Error('Invalid container profile')
    return containerExecSpec(parsed.engine, parsed.container)
  }

  if (profile.kind === 'unix') {
    // Windows bash ports need a login shell; POSIX shells take -l.
    const args = isWindows ? ['--login', '-i'] : ['-l']
    const exe = exeOf(profile) ?? (isWindows ? null : firstExisting(['/bin/bash', '/usr/bin/bash']))
    return { file: exe ?? process.env.SHELL ?? '/bin/bash', args, cwd: workdir }
  }

  return { file: process.env.SHELL ?? '/bin/sh', args: ['-l'], cwd: workdir }
}
