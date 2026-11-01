// Verifies the PTY native module loads inside the real Electron runtime (not just Node),
// which is what packaging depends on. Run with: npx electron scripts/pty-smoke.cjs
const { app } = require('electron')

app.disableHardwareAcceleration()

app.whenReady().then(() => {
  try {
    const pty = require('node-pty')
    if (typeof pty.spawn !== 'function') throw new Error('node-pty.spawn is missing')
    const shell = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'
    const child = pty.spawn(shell, [], { cols: 80, rows: 24, cwd: process.env.HOME || process.env.USERPROFILE })
    let output = ''
    child.onData((data) => {
      output += data
    })
    setTimeout(() => {
      child.write(process.platform === 'win32' ? 'echo PTY_SMOKE_OK\r' : 'echo PTY_SMOKE_OK\n')
      setTimeout(() => {
        const ok = output.includes('PTY_SMOKE_OK')
        console.log(ok ? 'SMOKE_PASS: node-pty spawned a live shell in Electron' : 'SMOKE_FAIL: no shell output')
        try {
          child.kill()
        } catch {
          /* already gone */
        }
        app.exit(ok ? 0 : 1)
      }, 1500)
    }, 500)
  } catch (error) {
    console.error('SMOKE_FAIL:', error instanceof Error ? error.message : error)
    app.exit(1)
  }
})
