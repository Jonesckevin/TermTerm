#!/usr/bin/env node
/**
 * Post-install repair pass.
 *
 * npm 11 gates dependency lifecycle scripts behind an approval list, and in practice
 * Electron's own postinstall (the binary download) can be skipped entirely. node-pty is
 * shipped without Linux prebuilds, so on Linux it must also be compiled after install.
 *
 * Root-level lifecycle scripts always run, so we finish the job here instead of asking
 * every contributor to remember `npm rebuild` / `node node_modules/electron/install.js`.
 * Set TERMTERM_SKIP_POSTINSTALL=1 to bypass (e.g. typecheck-only CI).
 */
const { existsSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

const root = join(__dirname, '..')
const modules = join(root, 'node_modules')
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function log(message) {
  console.log(`[termterm] ${message}`)
}

function run(file, args, cwd) {
  execFileSync(file, args, { cwd, stdio: 'inherit' })
}

if (process.env.TERMTERM_SKIP_POSTINSTALL === '1') {
  log('skipping post-install (TERMTERM_SKIP_POSTINSTALL=1)')
  process.exit(0)
}

// 1. Electron runtime binary.
const electronDir = join(modules, 'electron')
if (existsSync(electronDir) && !existsSync(join(electronDir, 'path.txt'))) {
  log('Electron binary missing – downloading it…')
  try {
    run(process.execPath, [join(electronDir, 'install.js')], electronDir)
    log('Electron binary ready')
  } catch {
    log('WARNING: could not download Electron. `npm run dev` will fail until it is installed.')
  }
}

// 2. node-pty native module (prebuilds on Windows/macOS, compiled on Linux).
const ptyDir = join(modules, 'node-pty')
if (existsSync(ptyDir)) {
  const compiled = existsSync(join(ptyDir, 'build', 'Release', 'pty.node'))
  const prebuilt = existsSync(join(ptyDir, 'prebuilds', `${process.platform}-${process.arch}`, 'pty.node'))
  if (!compiled && !prebuilt) {
    log(`Compiling node-pty for ${process.platform}-${process.arch} (this takes a minute)…`)
    run(npmCmd, ['rebuild', 'node-pty'], root)
    if (!existsSync(join(ptyDir, 'build', 'Release', 'pty.node'))) {
      log('ERROR: node-pty did not produce build/Release/pty.node – terminals will not start.')
      process.exit(1)
    }
    log('node-pty compiled')
  }
}
