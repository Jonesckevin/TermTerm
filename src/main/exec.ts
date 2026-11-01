import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Runs a command and returns its raw output, or null when it fails. */
export function runCapture(file: string, args: string[]): Buffer | null {
  try {
    return execFileSync(file, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000
    })
  } catch {
    return null
  }
}

export function decodeOutput(buffer: Buffer): string {
  // wsl.exe emits UTF-16LE; most other tools emit UTF-8.
  const looksUtf16 = buffer.length > 1 && buffer[1] === 0
  return (looksUtf16 ? buffer.toString('utf16le') : buffer.toString('utf8')).replace(/\0/g, '')
}

export function findOnPath(exe: string): string | null {
  const isWindows = process.platform === 'win32'
  const out = runCapture(isWindows ? 'where.exe' : 'which', [exe])
  if (!out) return null
  const first = decodeOutput(out)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && existsSync(line))
  return first ?? null
}

export function firstExisting(candidates: string[]): string | null {
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null
}
