// One-off: produce the README screenshot for sticky notes + links.
const { _electron: electron } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const userData = path.join(process.env.APPDATA ?? '', 'termterm')
  for (const file of ['layout.json', 'vault.json']) {
    const target = path.join(userData, file)
    if (fs.existsSync(target)) fs.unlinkSync(target)
  }

  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1'], cwd: root })
  const page = await app.firstWindow()
  await page.waitForSelector('.node', { timeout: 20000 })
  await sleep(2200)

  if (await page.locator('.lock-card').count()) {
    await page.click('.lock-card .link-button')
    await page.waitForSelector('.lock-screen', { state: 'detached' })
    await sleep(600)
  }

  // Move the terminal right so the note has room on the left.
  const terminal = page.locator('.node').first()
  const headerBox = await terminal.locator('.node-header').boundingBox()
  await page.mouse.move(headerBox.x + 80, headerBox.y + 14)
  await page.mouse.down()
  await page.mouse.move(headerBox.x + 80 + 210, headerBox.y + 14 - 40, { steps: 10 })
  await page.mouse.up()
  await sleep(400)

  await page.keyboard.press('Control+Shift+n')
  await sleep(700)
  const note = page.locator('.node.note').first()
  const canvasBox = await page.locator('.canvas').boundingBox()
  const noteHeader = await note.locator('.note-header').boundingBox()
  // Place the note at a known spot inside the canvas rather than guessing an offset.
  const targetX = canvasBox.x + 40
  const targetY = canvasBox.y + 170
  await page.mouse.move(noteHeader.x + 60, noteHeader.y + 14)
  await page.mouse.down()
  await page.mouse.move(noteHeader.x + 60 + (targetX - noteHeader.x), noteHeader.y + 14 + (targetY - noteHeader.y), {
    steps: 12
  })
  await page.mouse.up()
  await sleep(400)

  await note.locator('.note-text').fill('Deploy steps:\n1. git pull\n2. npm ci\n3. restart the service')
  await sleep(400)

  const port = await note.locator('.node-port.right').boundingBox()
  const target = await terminal.locator('.node-header').boundingBox()
  await page.mouse.move(port.x + port.width / 2, port.y + port.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x + 120, target.y + target.height / 2, { steps: 14 })
  await page.mouse.up()
  await sleep(900)

  await page.screenshot({ path: path.join(root, 'docs', 'notes.png') })
  await app.close()
}

main().catch((error) => {
  console.error('SHOT_FAILED', error)
  process.exit(1)
})

