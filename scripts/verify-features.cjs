// Feature verification: vault crypto, saved connections, Telnet, layers, lock/unlock.
const { _electron: electron } = require('playwright')
const net = require('node:net')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.join(__dirname, '..')
const shots = path.join(__dirname, '.shots')
fs.mkdirSync(shots, { recursive: true })

const MASTER_PASSWORD = 'correct horse battery staple'
const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` – ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

async function startTelnetServer() {
  const received = []
  let connections = 0
  const activeSockets = new Set()
  const server = net.createServer((socket) => {
    connections += 1
    activeSockets.add(socket)
    socket.on('close', () => activeSockets.delete(socket))
    // Announce with real TELNET negotiation so the filter is exercised.
    socket.write(Buffer.from([255, 251, 1]))
    socket.write('TermTerm test device\r\nlogin: ')
    socket.on('data', (chunk) => received.push(chunk.toString('utf8')))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    received,
    port: server.address().port,
    connections: () => connections,
    activeConnections: () => activeSockets.size
  }
}

async function createVault(page) {
  await page.waitForSelector('.lock-card', { timeout: 20000 })
  const heading = await page.locator('.lock-card h1').textContent()
  check('first launch asks for a master password', /Protect your connections/.test(heading ?? ''), heading ?? '')
  const inputs = page.locator('.lock-card input[type="password"]')
  check('setup asks for confirmation', (await inputs.count()) === 2)
  await inputs.nth(0).fill(MASTER_PASSWORD)
  await inputs.nth(1).fill(MASTER_PASSWORD)
  await page.click('.lock-card .primary-button')
  await page.waitForSelector('.lock-screen', { state: 'detached', timeout: 15000 })
}

async function main() {
  // Isolated profile: the suite never touches the developer's vault or layout.
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termterm-features-'))
  const userData = profileDir
  const launchArgs = ['.', '--force-device-scale-factor=1', `--user-data-dir=${profileDir}`]

  const telnet = await startTelnetServer()

  let app = await electron.launch({ args: launchArgs, cwd: root })
  let page = await app.firstWindow()
  await page.waitForSelector('.node', { timeout: 20000 })
  await sleep(1500)

  // --- vault creation ---
  await createVault(page)
  const vaultButton = await page.locator('.vault-button').textContent()
  check('vault reports unlocked after setup', /unlocked/i.test(vaultButton ?? ''), vaultButton ?? '')
  const vaultFile = path.join(userData, 'vault.json')
  check('vault file written to disk', fs.existsSync(vaultFile))

  const vaultJson = JSON.parse(fs.readFileSync(vaultFile, 'utf8'))
  check(
    'vault uses scrypt + AES-256-GCM',
    vaultJson.kdf?.name === 'scrypt' && vaultJson.cipher === 'aes-256-gcm' && vaultJson.kdf.N >= 16384,
    `N=${vaultJson.kdf?.N}`
  )
  check(
    'vault ciphertext does not contain the password',
    !fs.readFileSync(vaultFile, 'utf8').includes(MASTER_PASSWORD)
  )

  // --- saved connection (Telnet) ---
  await page.keyboard.press('Control+Shift+c')
  await page.waitForSelector('.dialog', { timeout: 5000 })
  check('Ctrl+Shift+C opens the connection editor', true)

  await page.click('.kind-option:has-text("Telnet")')
  const warnings = await page.locator('.banner.warning').first().textContent()
  check('editor warns that Telnet is cleartext', /clear text/i.test(warnings ?? ''), (warnings ?? '').slice(0, 60))

  await page.getByLabel('Name', { exact: true }).fill('Local Test Device')
  await page.getByLabel('Host', { exact: true }).fill('127.0.0.1')
  await page.getByLabel('Port', { exact: true }).fill(String(telnet.port))
  await page.screenshot({ path: path.join(shots, 'f1-connection-editor.png') })
  await page.click('.dialog .primary-button')
  await page.waitForSelector('.dialog', { state: 'detached', timeout: 10000 })

  const connectionRow = page.locator('.connection-row')
  check('connection appears in the sidebar', (await connectionRow.count()) === 1)

  // --- open the connection and talk to the telnet server ---
  await connectionRow.first().click()
  await sleep(2500)
  check('telnet node added to the canvas', (await page.locator('.node').count()) === 2)
  await page.locator('.node').last().locator('.node-body').click()
  await sleep(600)
  await page.keyboard.type('anonymous')
  await page.keyboard.press('Enter')
  await sleep(1500)
  const received = telnet.received.join('')
  check('telnet session reaches the server', /anonymous/.test(received), JSON.stringify(received.slice(0, 40)))
  await page.screenshot({ path: path.join(shots, 'f2-telnet-node.png') })

  // --- encrypted at rest ---
  await sleep(900)
  const vaultNow = fs.readFileSync(vaultFile, 'utf8')
  check('connection name is encrypted at rest', !vaultNow.includes('Local Test Device'))
  check('telnet host is encrypted at rest', !vaultNow.includes('127.0.0.1'))
  const layout = JSON.parse(fs.readFileSync(path.join(userData, 'layout.json'), 'utf8'))
  const layoutText = JSON.stringify(layout)
  check('layout.json holds no connection secrets', !layoutText.includes('127.0.0.1') && !layoutText.includes('Local Test Device'))
  check('layout stores a layer for every node', layout.nodes.every((node) => typeof node.layerId === 'string'))

  // --- layers ---
  const nodeCountBefore = await page.locator('.node').count()
  await page.click('.sidebar-section-header .icon-button[title="New layer"]')
  await sleep(400)
  check('new layer created', (await page.locator('.layer-row').count()) === 2)
  const layerRows = page.locator('.layer-row')
  await layerRows.nth(1).dblclick()
  await page.locator('.layer-name-input').fill('Ops')
  await page.keyboard.press('Enter')
  await sleep(300)
  check('layer renamed inline', (await page.locator('.layer-row').nth(1).textContent())?.includes('Ops'))

  // Drag the telnet terminal node (under Workspace) onto the new layer.
  const nodeRow = page.locator('.sidebar-item.nested', { hasText: 'telnet://' }).first()
  const sourceBox = await nodeRow.boundingBox()
  const targetBox = await page.locator('.layer-row:has-text("Ops")').boundingBox()
  await page.mouse.move(sourceBox.x + 40, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox.x + 40, targetBox.y + targetBox.height / 2, { steps: 14 })
  await page.mouse.up()
  await sleep(900)
  const layoutAfterDrag = JSON.parse(fs.readFileSync(path.join(userData, 'layout.json'), 'utf8'))
  const opsLayer = layoutAfterDrag.layers.find((layer) => layer.name === 'Ops')
  const movedNode = layoutAfterDrag.nodes.find((node) => node.connectionId)
  check(
    'dragging a terminal moves it between layers',
    Boolean(opsLayer && movedNode && movedNode.layerId === opsLayer.id),
    `layer=${movedNode?.layerId}`
  )

  // Hiding the layer removes its node from the canvas.
  await page.click('.layer-row:has-text("Ops") .icon-button[title="Hide this layer"]')
  await sleep(500)
  check(
    'hiding a layer hides its terminals',
    (await page.locator('.node').count()) === nodeCountBefore - 1,
    `${nodeCountBefore} -> ${await page.locator('.node').count()}`
  )
  await page.click('.layer-row:has-text("Ops") .icon-button[title="Show this layer"]')
  await sleep(400)
  check('showing the layer restores its terminals', (await page.locator('.node').count()) === nodeCountBefore)
  await page.screenshot({ path: path.join(shots, 'f3-layers.png') })

  // --- sticky notes and links ---
  await page.keyboard.press('Control+Shift+n')
  await sleep(700)
  check('Ctrl+Shift+N creates a sticky note', (await page.locator('.node.note').count()) === 1)

  let note = page.locator('.node.note').first()
  const noteHeader = await note.locator('.note-header').boundingBox()
  await page.mouse.move(noteHeader.x + 60, noteHeader.y + 14)
  await page.mouse.down()
  await page.mouse.move(noteHeader.x + 60 - 200, noteHeader.y + 14 + 380, { steps: 12 })
  await page.mouse.up()
  await sleep(500)

  note = page.locator('.node.note').first()
  await note.locator('.note-text').fill('sudo systemctl restart nginx')
  await sleep(700)

  const canvasBox = await page.locator('.canvas').boundingBox()
  const noteBox = await note.boundingBox()
  let terminalNode = page.locator('.node', { hasText: 'Local Test Device' }).first()

  // Move the terminal away from the note so the link curve has open space to click.
  const headerStart = await terminalNode.locator('.node-header').boundingBox()
  await page.mouse.move(headerStart.x + 60, headerStart.y + headerStart.height / 2)
  await page.mouse.down()
  await page.mouse.move(
    Math.min(canvasBox.x + canvasBox.width - 160, noteBox.x + noteBox.width + 460),
    noteBox.y + 60,
    { steps: 14 }
  )
  await page.mouse.up()
  await sleep(600)

  terminalNode = page.locator('.node', { hasText: 'Local Test Device' }).first()
  // Bring the target to the front so the drop lands on it rather than an overlapping node.
  await terminalNode.locator('.node-header').click()
  await sleep(300)
  const terminalNodeId = await terminalNode.getAttribute('data-node-id')
  const portBox = await note.locator('.node-port.right').boundingBox()
  const terminalBox = await terminalNode.locator('.node-header').boundingBox()
  await page.mouse.move(portBox.x + portBox.width / 2, portBox.y + portBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(terminalBox.x + terminalBox.width / 2, terminalBox.y + terminalBox.height / 2, { steps: 16 })
  await page.mouse.up()
  await sleep(900)

  check('dragging a node port creates a link', (await page.locator('path.node-link').count()) === 1)
  const layoutWithLinks = JSON.parse(fs.readFileSync(path.join(userData, 'layout.json'), 'utf8'))
  check('link is persisted', layoutWithLinks.links?.length === 1)
  const noteNodeId = layoutWithLinks.nodes.find((node) => node.kind === 'note')?.id
  const link = layoutWithLinks.links?.[0]
  const linkedNodeId = link ? (link.from === noteNodeId ? link.to : link.from) : undefined
  check('link connects the note to the telnet terminal', linkedNodeId === terminalNodeId, `${linkedNodeId}`)
  check(
    'note text is persisted',
    layoutWithLinks.nodes.some((node) => node.kind === 'note' && (node.text ?? '').includes('nginx'))
  )
  await page.screenshot({ path: path.join(shots, 'f4-note-linked.png') })

  telnet.received.length = 0
  await note.locator('.note-send').first().click()
  await sleep(1600)
  check(
    'a linked note can type its text into the terminal',
    /nginx/.test(telnet.received.join('')),
    JSON.stringify(telnet.received.join('').slice(0, 40))
  )

  // Find a point on the curve that is actually hit-testable (not covered by a node),
  // which also proves the wide invisible hit stroke works.
  const linkPoint = await page.evaluate(() => {
    const path = document.querySelector('path.node-link')
    const svg = path?.ownerSVGElement
    const ctm = path?.getScreenCTM()
    if (!path || !svg || !ctm) return null
    const total = path.getTotalLength()
    for (const ratio of [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9]) {
      const point = path.getPointAtLength(total * ratio)
      const svgPoint = svg.createSVGPoint()
      svgPoint.x = point.x
      svgPoint.y = point.y
      const transformed = svgPoint.matrixTransform(ctm)
      const element = document.elementFromPoint(transformed.x, transformed.y)
      if (element && (element.classList.contains('node-link-hit') || element.classList.contains('node-link'))) {
        return { x: transformed.x, y: transformed.y }
      }
    }
    return null
  })
  check('link stroke is hit-testable', Boolean(linkPoint))
  if (linkPoint) await page.mouse.click(linkPoint.x, linkPoint.y)
  await sleep(400)
  await page.locator('.link-remove').click()
  await sleep(700)
  check('a link can be removed', (await page.locator('path.node-link').count()) === 0)

  // --- layer deletion is explicit about its contents ---
  const layerRowCount = () => page.locator('.layer-row').count()
  const dragNodeIntoLastLayer = async () => {
    const row = page.locator('.sidebar-item.nested', { hasText: 'telnet://' }).first()
    const from = await row.boundingBox()
    const to = await page.locator('.layer-row').last().boundingBox()
    await page.mouse.move(from.x + 40, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(to.x + 40, to.y + to.height / 2, { steps: 12 })
    await page.mouse.up()
    await sleep(700)
  }

  // Empty layer: no prompt at all.
  await page.click('.sidebar-section-header .icon-button[title="New layer"]')
  await sleep(400)
  const layersBeforeEmptyDelete = await layerRowCount()
  await page.locator('.layer-row').last().locator('.icon-button[title="Delete layer"]').click()
  await sleep(500)
  check(
    'deleting an empty layer does not prompt',
    (await page.locator('.confirm-dialog').count()) === 0 &&
      (await layerRowCount()) === layersBeforeEmptyDelete - 1
  )

  // Populated layer: keep moves the terminal up.
  await page.click('.sidebar-section-header .icon-button[title="New layer"]')
  await sleep(400)
  await dragNodeIntoLastLayer()
  const nodesBeforeLayerDelete = await page.locator('.node').count()
  const layersBeforeKeep = await layerRowCount()
  await page.locator('.layer-row').last().locator('.icon-button[title="Delete layer"]').click()
  await page.waitForSelector('.confirm-dialog', { timeout: 5000 })
  const confirmText = await page.locator('.confirm-body').textContent()
  check('deleting a populated layer asks first', true, (confirmText ?? '').trim())
  check('the prompt states what is inside', /1 item/.test(confirmText ?? ''))
  await page.screenshot({ path: path.join(shots, 'f5-layer-delete.png') })

  await page.getByRole('button', { name: /Keep them/ }).click()
  await sleep(800)
  check(
    'keep moves the terminal up instead of deleting it',
    (await page.locator('.node').count()) === nodesBeforeLayerDelete,
    `${nodesBeforeLayerDelete} -> ${await page.locator('.node').count()}`
  )
  check(
    'keep removes only the deleted layer',
    (await layerRowCount()) === layersBeforeKeep - 1,
    `${layersBeforeKeep} -> ${await layerRowCount()}`
  )
  const keptStatus = await page
    .locator('.node', { hasText: 'Local Test Device' })
    .locator('.node-status')
    .getAttribute('class')
  check('the kept session is still running', Boolean(keptStatus?.includes('running')), keptStatus ?? '')

  // A parent that only contains a sublayer: keep must promote the sublayer, not drop it.
  const layersBeforeNested = await layerRowCount()
  const nodesBeforeNested = await page.locator('.node').count()
  await page.click('.sidebar-section-header .icon-button[title="New layer"]')
  await sleep(400)
  // Pin both rows by id: `.layer-row` locators re-resolve as soon as a row is added.
  const parentLayerId = await page.locator('.layer-row').last().getAttribute('data-layer-id')
  const parentRow = page.locator(`.layer-row[data-layer-id="${parentLayerId}"]`)
  await parentRow.hover()
  await parentRow.locator('.icon-button[title="New sublayer"]').click()
  await sleep(400)
  const sublayerId = await page.locator('.layer-row').last().getAttribute('data-layer-id')
  const sublayerRow = page.locator(`.layer-row[data-layer-id="${sublayerId}"]`)

  const noteRow = page.locator('.sidebar-item.nested', { hasText: 'sudo systemctl' }).first()
  const noteRowBox = await noteRow.boundingBox()
  const sublayerBox = await sublayerRow.boundingBox()
  await page.mouse.move(noteRowBox.x + 40, noteRowBox.y + noteRowBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(sublayerBox.x + 40, sublayerBox.y + sublayerBox.height / 2, { steps: 12 })
  await page.mouse.up()
  await sleep(800)
  const layoutNested = JSON.parse(fs.readFileSync(path.join(userData, 'layout.json'), 'utf8'))
  const noteLayer = layoutNested.nodes.find((node) => node.kind === 'note')?.layerId
  check('note lands in the sublayer', noteLayer === sublayerId, `${noteLayer} vs ${sublayerId}`)

  await parentRow.locator('.icon-button[title="Delete layer"]').click()
  await page.waitForSelector('.confirm-dialog', { timeout: 5000 })
  const nestedText = await page.locator('.confirm-body').textContent()
  check('prompt counts sublayers too', /1 sublayer/.test(nestedText ?? ''), (nestedText ?? '').trim())
  await page.getByRole('button', { name: /Keep them/ }).click()
  await sleep(800)
  check(
    'keep promotes the sublayer instead of deleting it',
    (await layerRowCount()) === layersBeforeNested + 1,
    `${layersBeforeNested + 1} expected, got ${await layerRowCount()}`
  )
  check(
    'the promoted sublayer still exists',
    (await page.locator(`.layer-row[data-layer-id="${sublayerId}"]`).count()) === 1
  )
  check(
    'items inside a promoted sublayer survive',
    (await page.locator('.node').count()) === nodesBeforeNested
  )
  await sleep(600)
  const layoutAfterKeep = JSON.parse(fs.readFileSync(path.join(userData, 'layout.json'), 'utf8'))
  const noteAfterKeep = layoutAfterKeep.nodes.find((node) => node.kind === 'note')
  check(
    'kept items stay inside the promoted sublayer',
    noteAfterKeep?.layerId === sublayerId,
    `${noteAfterKeep?.layerId} vs ${sublayerId}`
  )

  // Clean up the promoted sublayer (and the note it holds) before the remaining checks.
  await sublayerRow.locator('.icon-button[title="Delete layer"]').click()
  await page.waitForSelector('.confirm-dialog', { timeout: 5000 })
  await page.getByRole('button', { name: /Delete everything/ }).click()
  await sleep(900)

  // Populated layer: deleting everything also closes the session.
  await page.click('.sidebar-section-header .icon-button[title="New layer"]')
  await sleep(400)
  await dragNodeIntoLastLayer()
  const activeBeforePurge = telnet.activeConnections()
  const layersBeforePurge = await layerRowCount()
  const nodesBeforePurge = await page.locator('.node').count()
  await page.locator('.layer-row').last().locator('.icon-button[title="Delete layer"]').click()
  await page.waitForSelector('.confirm-dialog', { timeout: 5000 })
  await page.getByRole('button', { name: /Delete everything/ }).click()
  await sleep(1400)
  check(
    'delete everything removes the terminals in that layer',
    (await page.locator('.node').count()) === nodesBeforePurge - 1,
    `${nodesBeforePurge} -> ${await page.locator('.node').count()}`
  )
  check('delete everything closes the session', telnet.activeConnections() === activeBeforePurge - 1)
  check(
    'delete everything removes the layer',
    (await layerRowCount()) === layersBeforePurge - 1,
    `${layersBeforePurge} -> ${await layerRowCount()}`
  )

  // Restore a connection node for the remaining checks.
  await page.locator('.connection-row').first().click()
  await sleep(2500)

  // --- container shells ---
  let containerTarget = null
  try {
    const names = execFileSync('docker', ['ps', '--format', '{{.Names}}'])
      .toString()
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter(Boolean)
    for (const name of names) {
      try {
        execFileSync('docker', ['exec', name, 'sh', '-c', 'exit 0'], { stdio: 'ignore' })
        containerTarget = name
        break
      } catch {
        // image without /bin/sh
      }
    }
  } catch {
    containerTarget = null
  }

  if (!containerTarget) {
    console.log('SKIP  container checks (no running container with /bin/sh)')
  } else {
    await page.keyboard.press('Control+t')
    await page.waitForSelector('.picker', { timeout: 5000 })
    await page.locator('.picker-input input').fill(containerTarget)
    await sleep(500)
    const kinds = await page.locator('.picker-item .picker-item-kind').allTextContents()
    check(
      'running containers appear in the shell palette',
      kinds.some((kind) => kind.trim() === 'container'),
      kinds.join(',')
    )
    await page.screenshot({ path: path.join(shots, 'f6-container-picker.png') })

    await page.locator('.picker-item', { hasText: containerTarget }).first().click()
    await sleep(3500)

    const containerNode = page.locator('.node', { hasText: containerTarget }).last()
    check('a container terminal node opens', (await containerNode.count()) === 1)
    const bodyBox = await containerNode.locator('.node-body').boundingBox()
    await page.mouse.click(bodyBox.x + bodyBox.width / 2, bodyBox.y + bodyBox.height / 2)
    await sleep(500)
    await page.keyboard.type('touch /tmp/termterm-container-ok')
    await page.keyboard.press('Enter')
    await sleep(2500)

    let insideOk = false
    try {
      execFileSync('docker', ['exec', containerTarget, 'test', '-f', '/tmp/termterm-container-ok'])
      insideOk = true
    } catch {
      insideOk = false
    }
    check('the container shell runs commands inside that container', insideOk)
    await page.screenshot({ path: path.join(shots, 'f7-container-node.png') })

    try {
      execFileSync('docker', ['exec', containerTarget, 'rm', '-f', '/tmp/termterm-container-ok'])
    } catch {
      // best effort cleanup
    }
    await containerNode.locator('.node-header button[title="Close terminal"]').click()
    await page.locator('.confirm-dialog .choice-button.danger').click()
    await sleep(700)
  }

  // --- lock / unlock ---
  await page.click('.vault-button')
  await page.waitForSelector('.lock-card', { timeout: 5000 })
  const unlockHeading = await page.locator('.lock-card h1').textContent()
  check('locking shows the unlock screen', /Unlock TermTerm/.test(unlockHeading ?? ''))
  await page.locator('.lock-card input[type="password"]').first().fill('wrong password')
  await page.click('.lock-card .primary-button')
  await page.waitForSelector('.form-error', { timeout: 8000 })
  check('wrong master password is rejected', true, (await page.locator('.form-error').textContent()) ?? '')
  check(
    'connections hidden while locked',
    (await page.locator('.vault-locked').count()) === 1
  )
  await page.locator('.lock-card input[type="password"]').first().fill(MASTER_PASSWORD)
  await page.click('.lock-card .primary-button')
  await page.waitForSelector('.lock-screen', { state: 'detached', timeout: 15000 })
  check('correct password unlocks the vault', (await page.locator('.connection-row').count()) === 1)

  await page.screenshot({ path: path.join(shots, 'f4-unlocked.png') })
  await sleep(1000)
  await closeApp(app)
  await sleep(1500)

  // --- restart: layout + layers survive, vault starts locked ---
  app = await electron.launch({ args: launchArgs, cwd: root })
  page = await app.firstWindow()
  await page.waitForSelector('.lock-card', { timeout: 20000 })
  check('restart requires the master password', true)
  check(
    'locked connection nodes show a placeholder',
    (await page.locator('.node-placeholder').count()) >= 1,
    `${await page.locator('.node-placeholder').count()} placeholder(s)`
  )
  await page.screenshot({ path: path.join(shots, 'f5-locked-restart.png') })

  await page.locator('.lock-card input[type="password"]').first().fill(MASTER_PASSWORD)
  await page.click('.lock-card .primary-button')
  await page.waitForSelector('.lock-screen', { state: 'detached', timeout: 15000 })
  await sleep(2500)
  check('layers survive a restart', (await page.locator('.layer-row').count()) === 2)
  check('saved connection survives a restart', (await page.locator('.connection-row').count()) === 1)
  check(
    'connection node reconnects after unlock',
    (await page.locator('.node-placeholder').count()) === 0,
    `${await page.locator('.node-placeholder').count()} placeholder(s)`
  )
  await page.screenshot({ path: path.join(shots, 'f6-after-restart.png') })

  // --- X11 availability surfaces in the editor ---
  await page.keyboard.press('Control+Shift+c')
  await page.waitForSelector('.dialog', { timeout: 5000 })
  await page.click('.kind-option:has-text("SSH")')
  await page.locator('.dialog .checkbox input').first().check()
  await sleep(400)
  const x11Banner = await page.locator('.dialog .banner').last().textContent()
  check('X11 status is reported in the editor', /DISPLAY|X server|XQuartz/i.test(x11Banner ?? ''), (x11Banner ?? '').slice(0, 70))
  await page.screenshot({ path: path.join(shots, 'f7-x11.png') })
  await page.click('.dialog .ghost-button')

  await closeApp(app)
  telnet.server.close()
  fs.rmSync(profileDir, { recursive: true, force: true })

  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  // Exit explicitly: live Playwright handles would otherwise keep the suite running.
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error('FEATURE_VERIFY_FAILED', error)
  process.exit(1)
})



