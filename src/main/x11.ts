import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { X11Status } from '../shared/types'

const WINDOWS_X_SERVERS = [
  'C:\\Program Files\\VcXsrv\\vcxsrv.exe',
  'C:\\Program Files (x86)\\VcXsrv\\vcxsrv.exe',
  'C:\\Program Files\\Xming\\Xming.exe',
  'C:\\Program Files (x86)\\Xming\\Xming.exe',
  'C:\\Program Files\\X410\\X410.exe'
]

export function x11Status(): X11Status {
  const display = process.env.DISPLAY?.trim()

  if (process.platform === 'win32') {
    const server = WINDOWS_X_SERVERS.find((candidate) => existsSync(candidate))
    if (display && server) return { available: true, detail: `DISPLAY=${display} via ${basename(server)}` }
    if (display) return { available: true, detail: `DISPLAY=${display}` }
    if (server) {
      return {
        available: true,
        detail: `${basename(server)} installed – set DISPLAY=127.0.0.1:0.0 for X11 forwarding`
      }
    }
    return {
      available: false,
      detail: 'No X server found. Install VcXsrv or X410 and set DISPLAY=127.0.0.1:0.0'
    }
  }

  if (display) return { available: true, detail: `DISPLAY=${display}` }

  if (process.platform === 'darwin') {
    return existsSync('/opt/X11/bin/Xquartz')
      ? { available: false, detail: 'XQuartz is installed but not running – start it to forward X11' }
      : { available: false, detail: 'Install XQuartz to forward X11 from macOS' }
  }

  return {
    available: false,
    detail: 'No DISPLAY is set. Start an X server (or use a desktop session) to forward X11'
  }
}
