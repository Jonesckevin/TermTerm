// Unit checks for shell detection: compiled standalone, no Electron needed.
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const outDir = path.join(__dirname, '.profiles-build')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` – ${detail}` : ''}`)
}

fs.rmSync(outDir, { recursive: true, force: true })
// Invoke tsc through node directly: .cmd shims cannot be spawned without a shell on Windows.
const tscEntry = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
execFileSync(
  process.execPath,
  [
    tscEntry,
    'src/main/pty/profiles.ts',
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

const profiles = require(path.join(outDir, 'main', 'pty', 'profiles.js'))
const containers = require(path.join(outDir, 'main', 'containers.js'))

// --- candidate table ---
const candidates = profiles.windowsShellCandidates()
const ids = candidates.map((candidate) => candidate.id)
for (const expected of ['pwsh7', 'pwsh-preview', 'powershell', 'cmd', 'gitbash', 'msys2', 'cygwin', 'nu']) {
  check(`candidate table includes ${expected}`, ids.includes(expected))
}

const git = candidates.find((candidate) => candidate.id === 'gitbash')
check(
  'Git Bash does not probe PATH for bash.exe (would hit System32\\bash.exe)',
  !git.probes.includes('bash.exe'),
  `probes=[${git.probes.join(',')}]`
)
check(
  'Git Bash includes the per-user and scoop locations',
  git.paths.some((p) => /Programs[\\/]Git/i.test(p)) && git.paths.some((p) => /scoop/i.test(p))
)

const msys2 = candidates.find((candidate) => candidate.id === 'msys2')
check('MSYS2 covers usr/ucrt64/mingw64', ['usr', 'ucrt64', 'mingw64'].every((d) => msys2.paths.some((p) => p.includes(d))))

const cygwin = candidates.find((candidate) => candidate.id === 'cygwin')
check('Cygwin covers 32 and 64-bit installs', cygwin.paths.length >= 2)

const nu = candidates.find((candidate) => candidate.id === 'nu')
check(
  'Nushell probes PATH and common install locations',
  nu.probes.includes('nu.exe') && nu.paths.some((p) => /Nu[\\/]bin/i.test(p)) && nu.paths.some((p) => /scoop/i.test(p))
)

const preview = candidates.find((candidate) => candidate.id === 'pwsh-preview')
check('PowerShell 7 Preview has its own profile', Boolean(preview) && preview.paths.some((p) => /7-preview/.test(p)))

// --- ssh config parsing ---
const parsed = profiles.parseSshConfig(
  [
    '# leading comment',
    'Host prod',
    '  HostName example.com',
    '  User deploy',
    '  Port 2222',
    '  IdentityFile ~/.ssh/id_ed25519',
    '',
    'Host *.internal',
    '  User admin',
    '',
    'Host backup',
    '  User backup',
    '  Port 2200',
    '  User ignored'
  ].join('\n')
)

check('ssh: Host blocks are parsed', parsed.has('prod') && parsed.has('backup'))
check('ssh: wildcard hosts are skipped', !parsed.has('*.internal') && ![...parsed.keys()].some((h) => h.includes('*')))
check('ssh: user is read', parsed.get('prod').user === 'deploy', String(parsed.get('prod').user))
check('ssh: port is read', parsed.get('prod').port === 2222 && parsed.get('backup').port === 2200)
check(
  'ssh: identity file is expanded',
  (parsed.get('prod').identityFile ?? '').endsWith('id_ed25519') && !parsed.get('prod').identityFile.startsWith('~'),
  parsed.get('prod').identityFile
)
check('ssh: first value wins (ssh semantics)', parsed.get('backup').user === 'backup', parsed.get('backup').user)

// --- containers ---
const parsedContainers = containers.parseContainerList(
  'docker',
  ['abc123|web|nginx:latest', 'def456|db,db-alias|postgres:16', 'bad|--privileged|evil:1', ''].join('\n')
)
check('container list parses id/name/image', parsedContainers.length === 2 && parsedContainers[0].name === 'web')
check('container aliases collapse to the first name', parsedContainers[1]?.name === 'db', parsedContainers[1]?.name)
check('flag-like container names are dropped', !parsedContainers.some((entry) => entry.name.startsWith('-')))

const execSpec = containers.containerExecSpec('docker', 'web')
check('container exec uses -it and a shell', execSpec.args.join(' ') === 'exec -it web sh', execSpec.args.join(' '))
check('container exec honours the engine', /docker(\.exe)?$/i.test(execSpec.file), execSpec.file)

let rejectedName = false
try {
  containers.containerExecSpec('docker', '--privileged')
} catch {
  rejectedName = true
}
check('container exec rejects flag-like names', rejectedName)

let rejectedShell = false
try {
  containers.containerExecSpec('docker', 'web', 'sh -c evil')
} catch {
  rejectedShell = true
}
check('container exec rejects shell injection', rejectedShell)

const roundTrip = containers.parseContainerProfileId('container:docker:web-1')
check('container profile ids round-trip', roundTrip?.engine === 'docker' && roundTrip.container === 'web-1')

const liveContainers = containers.listContainers()
if (liveContainers.length > 0) {
  const containerProfiles = containers.listContainerProfiles()
  check(
    'running containers become shell profiles',
    containerProfiles.length === liveContainers.length &&
      containerProfiles.every((profile) => profile.kind === 'container'),
    `${containerProfiles.length} containers`
  )
  const containerSpec = profiles.buildSpawnSpec(containerProfiles[0])
  check(
    'container profile builds an exec spec',
    containerSpec.args[0] === 'exec' && containerSpec.args[1] === '-it',
    containerSpec.args.join(' ')
  )
} else {
  console.log('SKIP  container runtime checks (no running containers)')
}

// --- live detection on this machine ---
const detected = profiles.listProfiles()
check('listProfiles returns profiles', detected.length > 0, `${detected.length} profiles`)
check(
  'every profile is available and well formed',
  detected.every(
    (profile) =>
      profile.available === true &&
      typeof profile.name === 'string' &&
      profile.name.length > 0 &&
      typeof profile.badge === 'string' &&
      /^#[0-9a-f]{3,8}$/i.test(profile.accent) &&
      typeof profile.detail === 'string'
  )
)
check(
  'no profile is mislabelled as Git Bash from the WSL launcher',
  !detected.some((profile) => profile.name === 'Git Bash' && /System32[\\/]bash\.exe/i.test(profile.detail ?? '')),
  detected.find((p) => p.name === 'Git Bash')?.detail ?? 'Git Bash not installed'
)

if (process.platform === 'win32') {
  const names = detected.map((profile) => profile.name)
  check('Windows detects PowerShell 5.1', names.some((name) => /PowerShell 5\.1/.test(name)))
  check('Windows detects Command Prompt', names.some((name) => name === 'Command Prompt'))
  check(
    'WSL distros are detected',
    detected.some((profile) => profile.kind === 'wsl'),
    detected.filter((p) => p.kind === 'wsl').map((p) => p.name).join(', ')
  )

  const wsl = detected.find((profile) => profile.kind === 'wsl')
  if (wsl) {
    const spec = profiles.buildSpawnSpec(wsl)
    check('WSL spec passes -d and --cd', spec.args.includes('-d') && spec.args.includes('--cd'), spec.args.join(' '))
  }
}

// Spawn specs must resolve for everything the picker offers.
const spawnable = detected.filter((profile) =>
  ['powershell', 'cmd', 'unix', 'shell', 'ssh', 'wsl', 'container'].includes(profile.kind)
)
let specFailures = 0
for (const profile of spawnable) {
  try {
    const spec = profiles.buildSpawnSpec(profile)
    if (!spec.file || !Array.isArray(spec.args)) specFailures += 1
  } catch {
    specFailures += 1
  }
}
check('every offered profile produces a spawn spec', specFailures === 0, `${spawnable.length} checked`)

fs.rmSync(outDir, { recursive: true, force: true })

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exit(1)
