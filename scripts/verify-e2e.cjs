// End-to-end verification: real Electron, real PTYs (PowerShell + WSL), layout persistence.
const { _electron: electron } = require('playwright')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const root = path.join(__dirname, '..')
const shots = path.join(__dirname, '.shots')
fs.mkdirSync(shots, { recursive: true })

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` – ${detail}` : ''}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Playwright's close() can stay pending when the app finishes quitting first;
 * wait on the process itself so a suite can never hang at teardown.
 */
async function closeApp(app) {
  const child = app.process()
  if (child.exitCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  await Promise.race([app.close().catch(() => undefined), exited, sleep(8000)])
  if (child.exitCode === null) {
    child.kill()
    await Promise.race([exited, sleep(5000)])
  }
}

/**
 * Binds the port older builds used for the session host and never answers.
 * A stale host like this used to make every terminal fail with
 * "Session host did not respond"; the app must ignore it.
 */
function squatOldHostPort() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.on('data', () => undefined))
    server.once('error', () => resolve(null))
    server.listen(45871, '127.0.0.1', () => resolve(server))
  })
}

async function main() {
  // Isolated profile: the suite never touches the developer's TermTerm data and
  // can run while another TermTerm instance is open.
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termterm-e2e-'))
  const staleHost = await squatOldHostPort()
  const launchArgs = ['.', '--force-device-scale-factor=1', `--user-data-dir=${profileDir}`]
  let userData = profileDir

  const app = await electron.launch({ args: launchArgs, cwd: root })
  const page = await app.firstWindow()
  userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  const layoutFile = path.join(userData, 'layout.json')

  await page.waitForSelector('.node', { timeout: 20000 })
  await sleep(2500)

  // The optional vault prompt appears on first launch; these tests do not need it.
  if (await page.locator('.lock-card').count()) {
    await page.click('.lock-card .link-button')
    await page.waitForSelector('.lock-screen', { state: 'detached', timeout: 10000 })
    await sleep(600)
  }

  // 1. First run seeds exactly one node.
  check('first run seeds a terminal', (await page.locator('.node').count()) === 1)
  check(
    'a dead listener on the old host port is ignored',
    staleHost === null || (await page.locator('.node .node-status.running').count()) === 1,
    staleHost === null ? 'port 45871 was busy, not exercised' : 'terminal still started'
  )

  // 1b. The in-app help sheet carries the instructions the README used to.
  await page.keyboard.press('F1')
  await page.waitForSelector('.help-dialog', { timeout: 5000 })
  await page.screenshot({ path: path.join(shots, '9-help.png') })
  const helpText = (await page.locator('.help-body').textContent()) ?? ''
  check(
    'F1 opens the in-app help with shortcuts',
    /Ctrl T/.test(helpText) && /Shell palette/i.test(helpText),
    helpText.slice(0, 48)
  )
  const helpTabs = await page.locator('.help-tab').count()
  check('help covers the workflows the docs do', helpTabs >= 6, `${helpTabs} sections`)
  await page.click('.help-tab:has-text("Security")')
  const securityText = (await page.locator('.help-body').textContent()) ?? ''
  check('help explains the security model', /master password/i.test(securityText))
  await page.keyboard.press('Escape')
  await page.waitForSelector('.help-dialog', { state: 'detached', timeout: 5000 })
  check('Escape closes the help sheet', true)

  // 2. PowerShell PTY really executes commands typed through the UI.
  const probe = path.join(userData, 'pty-probe.txt')
  if (fs.existsSync(probe)) fs.unlinkSync(probe)
  await page.click('.node-body')
  await page.keyboard.type(`New-Item -ItemType File -Path '${probe}' -Force | Out-Null`)
  await page.keyboard.press('Enter')
  await sleep(2500)
  check('PowerShell PTY executes input', fs.existsSync(probe))

  // 3. Command palette creates a second, WSL-backed node.
  await page.keyboard.press('Control+t')
  await page.waitForSelector('.picker', { timeout: 5000 })
  check('Ctrl+T opens the shell picker', true)
  const pickerCount = await page.locator('.picker-item').count()
  check('picker lists detected shells', pickerCount >= 3, `${pickerCount} profiles`)
  await page.screenshot({ path: path.join(shots, '10-picker.png') })

  await page.fill('.picker-input input', 'Ubuntu')
  await sleep(250)
  const ubuntuVisible = await page.locator('.picker-item').first().textContent()
  await page.keyboard.press('Enter')
  await sleep(3000)
  check('picker creates a new node', (await page.locator('.node').count()) === 2, ubuntuVisible ?? '')

  // Clicking a terminal that is not on top must still focus it (no DOM reordering).
  const firstBodyBox = await page.locator('.node').first().locator('.node-body').boundingBox()
  await page.mouse.click(firstBodyBox.x + firstBodyBox.width / 2, firstBodyBox.y + firstBodyBox.height / 2)
  await sleep(400)
  const focusInNode = await page.evaluate(() => Boolean(document.activeElement?.closest('.node')))
  check('clicking a background terminal focuses its prompt', focusInNode)
  await page.screenshot({ path: path.join(shots, '11-two-nodes.png') })

  // 4. WSL node runs commands in the Linux distro.
  execFileSync('wsl.exe', ['-d', 'Ubuntu', 'rm', '-f', '/tmp/termterm-wsl-ok'])
  const wslNode = page.locator('.node').nth(1)
  await wslNode.locator('.node-body').click()
  await sleep(800)
  await page.keyboard.type('touch /tmp/termterm-wsl-ok && pwd > /tmp/termterm-pwd-check && uname -s')
  await page.keyboard.press('Enter')
  await sleep(3000)
  let wslOk = false
  try {
    execFileSync('wsl.exe', ['-d', 'Ubuntu', 'test', '-f', '/tmp/termterm-wsl-ok'])
    wslOk = true
  } catch {
    wslOk = false
  }
  check('WSL terminal executes Linux commands', wslOk)

  let wslPwd = ''
  try {
    wslPwd = execFileSync('wsl.exe', ['-d', 'Ubuntu', 'cat', '/tmp/termterm-pwd-check']).toString().trim()
  } catch {
    wslPwd = ''
  }
  check('WSL node starts in the Linux home directory', wslPwd.startsWith('/home/'), wslPwd)
  await page.screenshot({ path: path.join(shots, '12-wsl-output.png') })

  // 5. Dragging a node by its header moves it in world coordinates.
  const beforeDrag = await page.evaluate(() => {
    const node = document.querySelectorAll('.node')[1]
    const style = getComputedStyle(node)
    return { nx: style.getPropertyValue('--nx').trim(), ny: style.getPropertyValue('--ny').trim() }
  })
  const header = wslNode.locator('.node-header')
  const box = await header.boundingBox()
  await page.mouse.move(box.x + 60, box.y + 16)
  await page.mouse.down()
  await page.mouse.move(box.x + 60 - 260, box.y + 16 + 140, { steps: 12 })
  await page.mouse.up()
  await sleep(300)
  const afterDrag = await page.evaluate(() => {
    const node = document.querySelectorAll('.node')[1]
    const style = getComputedStyle(node)
    return { nx: style.getPropertyValue('--nx').trim(), ny: style.getPropertyValue('--ny').trim() }
  })
  check(
    'node drag updates world position',
    beforeDrag.nx !== afterDrag.nx || beforeDrag.ny !== afterDrag.ny,
    `${beforeDrag.nx},${beforeDrag.ny} -> ${afterDrag.nx},${afterDrag.ny}`
  )

  // 6. Resizing via the south-east handle.
  const beforeResize = await page.evaluate(() => {
    const node = document.querySelectorAll('.node')[1]
    const style = getComputedStyle(node)
    return { nw: Number(style.getPropertyValue('--nw')), nh: Number(style.getPropertyValue('--nh')) }
  })
  const handle = await wslNode.locator('.resize-handle.se').boundingBox()
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + 180, handle.y + 120, { steps: 10 })
  await page.mouse.up()
  await sleep(400)
  const afterResize = await page.evaluate(() => {
    const node = document.querySelectorAll('.node')[1]
    const style = getComputedStyle(node)
    return { nw: Number(style.getPropertyValue('--nw')), nh: Number(style.getPropertyValue('--nh')) }
  })
  check(
    'node resize changes world size',
    afterResize.nw > beforeResize.nw && afterResize.nh > beforeResize.nh,
    `${beforeResize.nw}x${beforeResize.nh} -> ${afterResize.nw}x${afterResize.nh}`
  )

  // 7. Wheel semantics: scrolling a terminal must not pan the canvas; ctrl+wheel still zooms.
  const bodyBox = await wslNode.locator('.node-body').boundingBox()
  await page.mouse.move(bodyBox.x + bodyBox.width / 2, bodyBox.y + bodyBox.height / 2)
  const camBefore = await page.evaluate(() =>
    Number(getComputedStyle(document.querySelector('.canvas')).getPropertyValue('--cam-x'))
  )
  await page.mouse.wheel(0, 300)
  await sleep(400)
  const camAfter = await page.evaluate(() =>
    Number(getComputedStyle(document.querySelector('.canvas')).getPropertyValue('--cam-x'))
  )
  check('wheel over terminal scrolls it instead of panning', camBefore === camAfter, `${camBefore} -> ${camAfter}`)

  const zoomBeforeWheel = await page.evaluate(() =>
    Number(getComputedStyle(document.querySelector('.canvas')).getPropertyValue('--zoom'))
  )
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, 300)
  await page.keyboard.up('Control')
  await sleep(400)
  const zoomAfterWheel = await page.evaluate(() =>
    Number(getComputedStyle(document.querySelector('.canvas')).getPropertyValue('--zoom'))
  )
  check(
    'ctrl+wheel over terminal zooms the canvas',
    zoomAfterWheel < zoomBeforeWheel,
    `${zoomBeforeWheel.toFixed(2)} -> ${zoomAfterWheel.toFixed(2)}`
  )
  await page.keyboard.press('Control+0')

  // 8. Restarting a shell keeps the node usable and does not leave a stale "exited" state.
  const firstNode = page.locator('.node').first()
  await firstNode.locator('.node-header button[title="Restart session"]').click()
  await sleep(3500)
  const restartState = await page.evaluate(() => {
    const node = document.querySelector('.node')
    return {
      running: node?.querySelector('.node-status')?.classList.contains('running') ?? false,
      overlay: Boolean(node?.querySelector('.node-restart-overlay'))
    }
  })
  check(
    'restart returns the node to a running shell',
    restartState.running && !restartState.overlay,
    JSON.stringify(restartState)
  )

  // 9. Closing a node from its header removes it (and its PTY).
  await page.keyboard.press('Control+t')
  await page.waitForSelector('.picker', { timeout: 5000 })
  await page.locator('.picker-input input').press('Enter')
  await sleep(2500)
  const countAfterAdd = await page.locator('.node').count()
  // The keyboard path and the header path share one confirmation dialog.
  await page.keyboard.press('Control+Shift+W')
  await page.waitForSelector('.confirm-dialog', { timeout: 3000 })
  await page.keyboard.press('Escape')
  await sleep(300)
  check(
    'Ctrl+Shift+W asks before closing',
    (await page.locator('.node').count()) === countAfterAdd &&
      (await page.locator('.confirm-dialog').count()) === 0,
    'node survives Escape'
  )
  await page.locator('.node').last().locator('.node-header button[title="Close terminal"]').click()
  await page.locator('.confirm-dialog .choice-button.danger').click()
  await sleep(900)
  const countAfterClose = await page.locator('.node').count()
  check(
    'closing a node removes it',
    countAfterClose === countAfterAdd - 1,
    `${countAfterAdd} -> ${countAfterClose}`
  )

  // The export handler must exist from the first render, not after a folder pick.
  const exportProbe = await page.evaluate(async () => {
    try {
      await window.termterm.exportTerminal(42, 'probe')
      return 'resolved'
    } catch (error) {
      return String(error)
    }
  })
  check('scrollback export is wired at startup', /Invalid terminal export/.test(exportProbe), exportProbe)

  // 10. Fit-all brings both nodes into view.
  await page.keyboard.press('Control+1')
  await sleep(500)
  const zoomAfterFit = await page.evaluate(() =>
    Number(getComputedStyle(document.querySelector('.canvas')).getPropertyValue('--zoom'))
  )
  check('Ctrl+1 fits all terminals', zoomAfterFit > 0 && zoomAfterFit <= 1, `zoom=${zoomAfterFit.toFixed(2)}`)
  await page.screenshot({ path: path.join(shots, '13-fit-all.png') })

  // 8. Layout is persisted to disk.
  await sleep(1200)
  const saved = JSON.parse(fs.readFileSync(layoutFile, 'utf8'))
  check('layout persisted with both nodes', saved.nodes.length === 2, layoutFile)
  const savedIds = saved.nodes.map((node) => node.id)
  const savedPositions = saved.nodes.map((node) => `${node.x},${node.y},${node.w}x${node.h}`)

  await page.screenshot({ path: path.join(shots, '14-before-restart.png') })
  await closeApp(app)
  await sleep(1500)

  // 9. Relaunch restores the same nodes at the same geometry.
  const app2 = await electron.launch({ args: launchArgs, cwd: root })
  const page2 = await app2.firstWindow()
  await page2.waitForSelector('.node', { timeout: 20000 })
  await sleep(3000)
  const restored = await page2.evaluate(() =>
    [...document.querySelectorAll('.node')].map((node) => {
      const style = getComputedStyle(node)
      return {
        nx: Number(style.getPropertyValue('--nx')),
        ny: Number(style.getPropertyValue('--ny')),
        nw: Number(style.getPropertyValue('--nw')),
        nh: Number(style.getPropertyValue('--nh'))
      }
    })
  )
  check('restart restores node count', restored.length === 2, `${restored.length} nodes`)
  const restoredPositions = restored.map((node) => `${node.nx},${node.ny},${node.nw}x${node.nh}`)
  check(
    'restart restores node geometry',
    JSON.stringify(restoredPositions) === JSON.stringify(savedPositions),
    `${restoredPositions.join(' | ')}`
  )
  const runningCount = await page2.evaluate(
    () => document.querySelectorAll('.node .node-status.running').length
  )
  check('restored terminals respawn shells', runningCount === 2, `${runningCount} running`)
  await page2.screenshot({ path: path.join(shots, '15-after-restart.png') })

  // Cleanup
  if (fs.existsSync(probe)) fs.unlinkSync(probe)
  try {
    execFileSync('wsl.exe', ['-d', 'Ubuntu', 'rm', '-f', '/tmp/termterm-wsl-ok', '/tmp/termterm-pwd-check'])
  } catch {
    // ignore
  }
  await closeApp(app2)
  staleHost?.close()
  fs.rmSync(profileDir, { recursive: true, force: true })

  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  // Exit explicitly: live Playwright handles would otherwise keep the suite running.
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error('VERIFY_FAILED', error)
  process.exit(1)
})

