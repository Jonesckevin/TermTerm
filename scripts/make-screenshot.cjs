// One-off: produce the README hero screenshot with three heterogeneous shells on the canvas.
const { _electron: electron } = require('playwright')
const path = require('node:path')

const root = path.join(__dirname, '..')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function addShell(page, filter) {
  await page.keyboard.press('Control+t')
  await page.waitForSelector('.picker', { timeout: 5000 })
  await page.fill('.picker-input input', filter)
  await sleep(200)
  await page.locator('.picker-input input').press('Enter')
  await sleep(2600)
}

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
    await page.waitForSelector('.lock-screen', { state: 'detached', timeout: 10000 })
    await sleep(600)
  }

  await addShell(page, 'WSL')
  await addShell(page, 'Command Prompt')

  // Give each node a distinct size/position via drag + resize so the canvas reads as a workspace.
  const nodes = page.locator('.node')
  const second = nodes.nth(1)
  const box = await second.locator('.node-header').boundingBox()
  await page.mouse.move(box.x + 40, box.y + 16)
  await page.mouse.down()
  await page.mouse.move(box.x + 40 + 600, box.y + 16 - 360, { steps: 12 })
  await page.mouse.up()
  await sleep(400)

  const third = nodes.nth(2)
  const box3 = await third.locator('.node-header').boundingBox()
  await page.mouse.move(box3.x + 40, box3.y + 16)
  await page.mouse.down()
  await page.mouse.move(box3.x + 40 - 560, box3.y + 16 + 330, { steps: 12 })
  await page.mouse.up()
  await sleep(600)

  await page.keyboard.press('Control+1')
  await sleep(900)
  await page.screenshot({ path: path.join(root, 'docs', 'canvas.png') })
  await app.close()
}

main().catch((error) => {
  console.error('SHOT_FAILED', error)
  process.exit(1)
})
