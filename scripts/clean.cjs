// Removes generated build output so a packaging run never ships stale artifacts.
// electron-builder does not empty its output directory, so old installers from a
// previous version would otherwise stay in dist/.
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')

// `dist/TermTerm-data` is written by the portable build when it runs from dist/:
// it holds that copy's layout and vault, so it is never treated as build output.
const targets = [
  { dir: 'out', keep: [] },
  { dir: 'dist', keep: ['TermTerm-data'] }
]

function clean() {
  for (const { dir, keep } of targets) {
    const full = path.join(root, dir)
    if (path.dirname(full) !== root) throw new Error(`Refusing to clean ${full}`)
    if (!fs.existsSync(full)) continue

    for (const entry of fs.readdirSync(full)) {
      if (keep.includes(entry)) continue
      const target = path.join(full, entry)
      try {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch (error) {
        if (['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
          throw new Error(
            `Cannot remove ${path.join(dir, entry)}: it is in use. ` +
              `Close the TermTerm build running from ${dir}/ and run the command again.`
          )
        }
        throw error
      }
    }
    console.log(`cleaned ${dir}${path.sep}`)
  }
}

try {
  clean()
} catch (error) {
  console.error(`\n${error.message}`)
  process.exit(1)
}
