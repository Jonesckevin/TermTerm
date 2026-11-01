// SFTP verification: known_hosts unit checks, then a real SSH server end-to-end.
//
//   npm run verify:sftp                  unit checks only
//   node scripts/sshd-fixture.cjs start  provision a throwaway server in WSL
//   npm run verify:sftp                  unit + end-to-end against it
const { _electron: electron } = require('playwright')
const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.join(__dirname, '..')
const outDir = path.join(__dirname, '.sftp-build')
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

function buildUnits() {
  fs.rmSync(outDir, { recursive: true, force: true })
  const tscEntry = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  execFileSync(
    process.execPath,
    [
      tscEntry,
      'src/main/ssh/knownHosts.ts',
      '--ignoreConfig',
      '--outDir',
      outDir,
      '--module',
      'nodenext',
      '--target',
      'es2022',
      '--types',
      'node',
      '--skipLibCheck'
    ],
    { cwd: root, stdio: 'inherit' }
  )
  const compiled = [
    path.join(outDir, 'main', 'ssh', 'knownHosts.js'),
    path.join(outDir, 'knownHosts.js')
  ].find((candidate) => fs.existsSync(candidate))
  if (!compiled) throw new Error('knownHosts.ts was not compiled')
  return require(compiled)
}

function fakeHostKey(type = 'ssh-ed25519') {
  const typeBuffer = Buffer.from(type, 'ascii')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(typeBuffer.length, 0)
  return Buffer.concat([header, typeBuffer, crypto.randomBytes(32)])
}

function hashedHostField(host) {
  const salt = crypto.randomBytes(20)
  const digest = crypto.createHmac('sha1', salt).update(host).digest()
  return `|1|${salt.toString('base64')}|${digest.toString('base64')}`
}

function sha256Fingerprint(blob) {
  return `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
}

function unitChecks(knownHosts) {
  const key = fakeHostKey()
  const keyBase64 = key.toString('base64')
  const otherKey = fakeHostKey()

  const plain = `203.0.113.9 ${knownHosts.keyTypeOf(key)} ${keyBase64}`
  check('plain known_hosts entry verifies', knownHosts.verifyHostKey(plain, '203.0.113.9', 22, key).status === 'match')
  check(
    'verdict reports the matching key type',
    knownHosts.verifyHostKey(plain, '203.0.113.9', 22, key).keyType === 'ssh-ed25519'
  )
  check(
    'a different key for a known host is a mismatch',
    knownHosts.verifyHostKey(plain, '203.0.113.9', 22, otherKey).status === 'mismatch'
  )
  const mismatch = knownHosts.verifyHostKey(plain, '203.0.113.9', 22, otherKey)
  check(
    'mismatch reports the stored fingerprint',
    mismatch.status === 'mismatch' && mismatch.known[0].fingerprint === sha256Fingerprint(key),
    mismatch.status === 'mismatch' ? mismatch.known[0].fingerprint : ''
  )
  check('an unseen host is unknown', knownHosts.verifyHostKey(plain, '203.0.113.10', 22, key).status === 'unknown')
  check('an empty known_hosts is unknown', knownHosts.verifyHostKey('', '203.0.113.9', 22, key).status === 'unknown')

  const portEntry = `[203.0.113.9]:2222 ${knownHosts.keyTypeOf(key)} ${keyBase64}`
  check('port-qualified entries verify', knownHosts.verifyHostKey(portEntry, '203.0.113.9', 2222, key).status === 'match')
  check(
    'port-qualified entries do not apply to port 22',
    knownHosts.verifyHostKey(portEntry, '203.0.113.9', 22, key).status === 'unknown'
  )

  const hashed = `${hashedHostField('hashed.example.com')} ${knownHosts.keyTypeOf(key)} ${keyBase64}`
  check('hashed entries verify', knownHosts.verifyHostKey(hashed, 'hashed.example.com', 22, key).status === 'match')
  check(
    'hashed entries do not match another host',
    knownHosts.verifyHostKey(hashed, 'other.example.com', 22, key).status === 'unknown'
  )

  const wildcard = `*.example.org ${knownHosts.keyTypeOf(key)} ${keyBase64}`
  check('wildcard patterns verify', knownHosts.verifyHostKey(wildcard, 'box.example.org', 22, key).status === 'match')
  const negated = `!bad.example.org,*.example.org ${knownHosts.keyTypeOf(key)} ${keyBase64}`
  check(
    'negated patterns exclude a host',
    knownHosts.verifyHostKey(negated, 'bad.example.org', 22, key).status === 'unknown'
  )

  const revoked = `@revoked 203.0.113.9 ${knownHosts.keyTypeOf(key)} ${keyBase64}`
  check('@revoked keys are rejected', knownHosts.verifyHostKey(revoked, '203.0.113.9', 22, key).status === 'revoked')

  const caLine = `@cert-authority *.example.net ${knownHosts.keyTypeOf(otherKey)} ${otherKey.toString('base64')}`
  check(
    '@cert-authority lines never cause a mismatch',
    knownHosts.verifyHostKey(caLine, 'box.example.net', 22, key).status === 'unknown'
  )

  const noisy = [
    '# a comment',
    '',
    'not-a-real-line',
    `203.0.113.9 ${knownHosts.keyTypeOf(key)} ${keyBase64}`
  ].join('\n')
  check('comments and malformed lines are ignored', knownHosts.parseKnownHosts(noisy).length === 1)
  check('fingerprints use the OpenSSH SHA256 form', knownHosts.fingerprint(key) === sha256Fingerprint(key))
  check('the key type is read from the key blob', knownHosts.keyTypeOf(key) === 'ssh-ed25519')

  const line = knownHosts.knownHostsLine('203.0.113.9', 2222, key)
  check('generated lines round-trip through verification', /^\[203\.0\.113\.9\]:2222 ssh-ed25519 /.test(line))
  check('generated lines verify', knownHosts.verifyHostKey(line, '203.0.113.9', 2222, key).status === 'match')
}

async function createVault(page) {
  await page.waitForSelector('.lock-card', { timeout: 20000 })
  const inputs = page.locator('.lock-card input[type="password"]')
  await inputs.nth(0).fill(MASTER_PASSWORD)
  await inputs.nth(1).fill(MASTER_PASSWORD)
  await page.click('.lock-card .primary-button')
  await page.waitForSelector('.lock-screen', { state: 'detached', timeout: 15000 })
}

async function addConnection(page, fields) {
  await page.keyboard.press('Control+Shift+c')
  await page.waitForSelector('.dialog', { timeout: 8000 })
  await page.click('.kind-option:has-text("SSH")')
  await page.getByLabel('Name', { exact: true }).fill(fields.name)
  await page.getByLabel('Host', { exact: true }).fill(fields.host)
  await page.getByLabel('Port', { exact: true }).fill(String(fields.port))
  await page.getByLabel('Username', { exact: true }).fill(fields.username)
  if (fields.identityFile) await page.getByLabel('Identity file', { exact: true }).fill(fields.identityFile)
  if (fields.password) await page.locator('.dialog input[type="password"]').fill(fields.password)
  await page.click('.dialog .primary-button')
  await page.waitForSelector('.dialog', { state: 'detached', timeout: 15000 })
}

async function openFiles(page, rowIndex) {
  await page.locator('.connection-row').nth(rowIndex).click()
  await sleep(2200)
  const node = page.locator('.node').last()
  await node.locator('button[title="Browse files (SFTP)"]').click()
  const panel = node.locator('.sftp-panel')
  await panel.waitFor({ timeout: 15000 })
  return { node, panel }
}

async function endToEnd(knownHosts) {
  const host = process.env.TERMTERM_SSH_HOST
  const port = Number(process.env.TERMTERM_SSH_PORT || 22)
  const user = process.env.TERMTERM_SSH_USER || 'root'
  const keyPath = process.env.TERMTERM_SSH_KEY
  const password = process.env.TERMTERM_SSH_PASSWORD
  if (!host || !keyPath) {
    console.log('\nSKIP  end-to-end checks (set TERMTERM_SSH_HOST / _USER / _KEY, see scripts/sshd-fixture.cjs)')
    return
  }

  const hostKeyPath = process.env.TERMTERM_SSH_HOST_KEY || path.join(path.dirname(keyPath), 'host_ed25519.pub')
  const serverKey = fs.readFileSync(hostKeyPath, 'utf8').trim().split(/\s+/)[1]
  const expectedFingerprint = sha256Fingerprint(Buffer.from(serverKey, 'base64'))
  // Isolated profile: the suite never touches the developer's vault, layout or
  // approved host keys.
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termterm-sftp-'))
  const userData = profileDir
  const launchArgs = ['.', '--force-device-scale-factor=1', `--user-data-dir=${profileDir}`]
  const home = user === 'root' ? '/root' : `/home/${user}`

  const uploadPath = path.join(os.tmpdir(), 'termterm-sftp-upload.txt')
  const downloadPath = path.join(os.tmpdir(), 'termterm-sftp-download.txt')
  fs.writeFileSync(uploadPath, 'uploaded by termterm\n')

  const app = await electron.launch({ args: launchArgs, cwd: root })
  const page = await app.firstWindow()
  await page.waitForSelector('.node', { timeout: 20000 })
  await sleep(1500)
  await createVault(page)

  await addConnection(page, { name: 'SFTP key host', host, port, username: user, identityFile: keyPath })
  const { node, panel } = await openFiles(page, 0)
  await panel.locator('.sftp-trust').waitFor({ timeout: 25000 })
  const challenge = await panel.locator('.sftp-trust code').textContent()
  check(
    'an unknown host key is shown before anything is sent',
    (challenge ?? '').includes(expectedFingerprint),
    challenge ?? ''
  )
  await page.screenshot({ path: path.join(shots, 's1-host-key.png') })

  await panel.locator('.sftp-trust .mini-button.primary').click()
  await panel.locator('.sftp-row').first().waitFor({ timeout: 25000 })
  const listingPath = (await panel.locator('.sftp-path').textContent())?.trim()
  check('trusting the key opens the login folder', listingPath === home, listingPath ?? '')

  const trustedFile = path.join(userData, 'known_hosts')
  const trusted = fs.existsSync(trustedFile) ? fs.readFileSync(trustedFile, 'utf8') : ''
  check(
    'the approved key is written to TermTerm known_hosts',
    trusted.includes(`[${host}]:${port}`) && trusted.includes(serverKey),
    trusted.trim().slice(0, 60)
  )
  check(
    'the approved key verifies on the next connection',
    knownHosts.verifyHostKey(trusted, host, port, Buffer.from(serverKey, 'base64')).status === 'match'
  )

  const connectionId = await page.evaluate(async () => (await window.termterm.listConnections())[0].id)

  // --- folder lifecycle through the UI ---
  await node.locator('button[title="New folder"]').click()
  await panel.locator('.sftp-inline input').fill('made-by-termterm')
  await page.keyboard.press('Enter')
  await panel.locator('.sftp-row:has-text("made-by-termterm")').waitFor({ timeout: 15000 })
  check('New folder creates a remote directory', true)

  await panel.locator('.sftp-row:has-text("made-by-termterm")').click({ button: 'right' })
  await page.click('.context-menu-item:has-text("Rename")')
  await panel.locator('.sftp-inline input').fill('renamed-by-termterm')
  await page.keyboard.press('Enter')
  await panel.locator('.sftp-row:has-text("renamed-by-termterm")').waitFor({ timeout: 15000 })
  check('Rename keeps the folder and changes its name', true)

  // --- upload / download round trip (the same primitives drag-and-drop uses) ---
  const upload = await page.evaluate(
    ({ id, directory, file }) => window.termterm.sftpUploadFiles(id, directory, [file]),
    { id: connectionId, directory: home, file: uploadPath }
  )
  check(
    'upload writes the local file to the host',
    upload.ok && upload.value.uploaded.length === 1,
    upload.ok ? upload.value.uploaded[0]?.name : upload.error
  )
  await node.locator('button[title="Refresh"]').click()
  await panel.locator('.sftp-row:has-text("termterm-sftp-upload.txt")').waitFor({ timeout: 15000 })
  check('the uploaded file appears in the listing', true)

  if (fs.existsSync(downloadPath)) fs.unlinkSync(downloadPath)
  const download = await page.evaluate(
    ({ id, remote, local }) => window.termterm.sftpDownload(id, remote, local),
    { id: connectionId, remote: `${home}/termterm-sftp-upload.txt`, local: downloadPath }
  )
  check(
    'download returns the same bytes',
    download.ok &&
      Boolean(download.value) &&
      fs.readFileSync(downloadPath, 'utf8') === fs.readFileSync(uploadPath, 'utf8'),
    download.ok ? `${download.value?.size ?? 0} bytes` : download.error
  )

  const stat = await page.evaluate(
    ({ id, remote }) => window.termterm.sftpStat(id, remote),
    { id: connectionId, remote: `${home}/renamed-by-termterm` }
  )
  check('stat reports the folder as a directory', stat.ok && stat.value.kind === 'dir')

  // --- deleting a file asks too ---
  await panel.locator('.sftp-row:has-text("termterm-sftp-upload.txt")').click({ button: 'right' })
  await page.locator('.context-menu-item:has-text("Delete")').first().click()
  await page.waitForSelector('.confirm-dialog', { timeout: 8000 })
  check('deleting a file asks for confirmation', true)
  await page.click('.confirm-dialog .choice-button.danger')
  await panel
    .locator('.sftp-row:has-text("termterm-sftp-upload.txt")')
    .waitFor({ state: 'detached', timeout: 15000 })
  check('the file is removed from the listing', true)

  // --- deleting a folder asks first, then removes the subtree ---
  await panel.locator('.sftp-row:has-text("renamed-by-termterm")').click({ button: 'right' })
  await page.click('.context-menu-item:has-text("Delete folder")')
  await page.waitForSelector('.confirm-dialog', { timeout: 8000 })
  check('deleting a folder asks for confirmation', true)
  await page.screenshot({ path: path.join(shots, 's2b-confirm.png') })
  await page.click('.confirm-dialog .choice-button.danger')
  await panel.locator('.sftp-row:has-text("renamed-by-termterm")').waitFor({ state: 'detached', timeout: 15000 })
  check('the folder is removed from the listing', true)

  const afterDelete = await page.evaluate(
    ({ id, remote }) => window.termterm.sftpList(id, remote),
    { id: connectionId, remote: home }
  )
  check(
    'the folder is gone on the server',
    afterDelete.ok && !afterDelete.value.entries.some((entry) => entry.name === 'renamed-by-termterm')
  )

  await page.screenshot({ path: path.join(shots, 's2-sftp-list.png') })

  // --- password auth: the vault secret reaches the SFTP client ---
  if (password) {
    await addConnection(page, { name: 'SFTP password host', host, port, username: user, password })
    const second = await openFiles(page, 1)
    await second.panel.locator('.sftp-row').first().waitFor({ timeout: 25000 })
    check(
      'a vault-stored password authenticates the file browser',
      (await second.panel.locator('.sftp-trust').count()) === 0,
      (await second.panel.locator('.sftp-path').textContent())?.trim() ?? ''
    )
    const vaultJson = fs.readFileSync(path.join(userData, 'vault.json'), 'utf8')
    check('the password is not stored in plaintext', !vaultJson.includes(password))
    await second.node.locator('button[title="Close terminal"]').click()
    await page.locator('.confirm-dialog .choice-button.danger').click()
    await sleep(600)
  }

  // --- a changed host key is refused, with no trust shortcut ---
  const originalKnownHosts = fs.readFileSync(trustedFile, 'utf8')
  const rogue = fakeHostKey()
  fs.writeFileSync(trustedFile, `[${host}]:${port} ssh-ed25519 ${rogue.toString('base64')}\n`)
  const mismatch = await page.evaluate(async (id) => {
    window.termterm.sftpDisconnect(id)
    return window.termterm.sftpList(id)
  }, connectionId)
  check(
    'a changed host key is refused',
    !mismatch.ok && /Host key verification failed/.test(mismatch.error),
    mismatch.ok ? 'unexpectedly connected' : mismatch.error.slice(0, 90)
  )
  check('a changed host key cannot be trusted from the UI', !mismatch.hostKey)
  fs.writeFileSync(trustedFile, originalKnownHosts)

  // Back to normal, then a clean capture for the README.
  await panel.locator('button[title="Refresh"]').click()
  await panel.locator('.sftp-row').first().waitFor({ timeout: 20000 })
  await page.evaluate(() => {
    const button = document.querySelector('.node button[title="Close terminal"]')
    if (button instanceof HTMLElement) button.click()
  })
  await page.locator('.confirm-dialog .choice-button.danger').click()
  await sleep(800)
  await page.screenshot({ path: path.join(shots, 's3-sftp.png') })

  await closeApp(app)
  fs.rmSync(profileDir, { recursive: true, force: true })
  for (const file of [uploadPath, downloadPath]) {
    if (fs.existsSync(file)) fs.unlinkSync(file)
  }
}

async function main() {
  const knownHosts = buildUnits()
  unitChecks(knownHosts)
  if (!process.argv.includes('--unit')) await endToEnd(knownHosts)

  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  // Exit explicitly: live Playwright handles would otherwise keep the suite running.
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error('SFTP_VERIFY_FAILED', error)
  process.exit(1)
})
