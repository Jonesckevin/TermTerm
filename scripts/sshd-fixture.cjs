// Provisions a throwaway OpenSSH server inside WSL so the SFTP browser can be
// tested against a real server. Nothing outside the WSL distro is touched.
//
//   node scripts/sshd-fixture.cjs start   -> prints the env vars for verify:sftp
//   node scripts/sshd-fixture.cjs stop
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PORT = Number(process.env.TERMTERM_SSH_PORT || 2222)
const USER = 'termterm'
const PASSWORD = 'termterm-sftp-test'
const WORK = '/tmp/termterm-sshd'
const keyDir = path.join(os.tmpdir(), 'termterm-sshd')
const localKey = path.join(keyDir, 'id_ed25519')
const localPublicKey = `${localKey}.pub`
const localHostPublicKey = path.join(keyDir, 'host_ed25519.pub')

function wsl(script, options = {}) {
  return execFileSync('wsl', ['-u', 'root', '-e', 'bash', '-s'], {
    input: script,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options
  })
}

const setup = `
set -e
export DEBIAN_FRONTEND=noninteractive
mkdir -p /run/sshd ${WORK}
if ! command -v sshd >/dev/null || [ ! -x /usr/lib/openssh/sftp-server ]; then
  apt-get update -qq
  apt-get install -y -qq openssh-server >/dev/null
fi
cd ${WORK}
[ -f host_ed25519 ] || ssh-keygen -q -t ed25519 -f host_ed25519 -N ''
[ -f client_ed25519 ] || ssh-keygen -q -t ed25519 -f client_ed25519 -N ''
id ${USER} >/dev/null 2>&1 || useradd -m -s /bin/bash ${USER}
# useradd leaves the account locked, which sshd refuses even for key auth.
usermod -p '*' ${USER}
echo '${USER}:${PASSWORD}' | chpasswd
mkdir -p /home/${USER}/.ssh /home/${USER}/sftp
cp client_ed25519.pub /home/${USER}/.ssh/authorized_keys
chown -R ${USER}:${USER} /home/${USER}/.ssh /home/${USER}/sftp
chmod 700 /home/${USER}/.ssh
chmod 600 /home/${USER}/.ssh/authorized_keys
cat > sshd_config <<'EOF'
Port ${PORT}
ListenAddress 127.0.0.1
HostKey ${WORK}/host_ed25519
PidFile ${WORK}/sshd.pid
UsePAM no
PasswordAuthentication yes
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers ${USER}
Subsystem sftp internal-sftp
StrictModes no
LogLevel INFO
EOF
pkill -F ${WORK}/sshd.pid 2>/dev/null || true
/usr/sbin/sshd -f ${WORK}/sshd_config -E ${WORK}/sshd.log
sleep 0.5
cat ${WORK}/client_ed25519
echo '---PUBLIC---'
cat ${WORK}/client_ed25519.pub
echo '---HOSTPUBLIC---'
cat ${WORK}/host_ed25519.pub
`

function start() {
  const output = wsl(setup)
  const [privateKey, rest = ''] = output.split('---PUBLIC---')
  const [publicKey = '', hostPublicKey = ''] = rest.split('---HOSTPUBLIC---')
  fs.mkdirSync(keyDir, { recursive: true })
  // ssh-keygen output can precede the key; keep only the PEM block.
  const key = privateKey.slice(privateKey.indexOf('-----BEGIN OPENSSH PRIVATE KEY-----'))
  if (!key.includes('BEGIN OPENSSH PRIVATE KEY')) throw new Error(`No private key in output:\n${output}`)
  fs.writeFileSync(localKey, key, { mode: 0o600 })
  fs.writeFileSync(localPublicKey, `${publicKey.trim()}\n`)
  fs.writeFileSync(localHostPublicKey, `${hostPublicKey.trim()}\n`)
  console.log(`fixture ready on 127.0.0.1:${PORT} (user ${USER}, password ${PASSWORD})`)
  console.log(`private key: ${localKey}`)
  console.log('')
  console.log(`$env:TERMTERM_SSH_HOST='127.0.0.1'; $env:TERMTERM_SSH_PORT='${PORT}'`)
  console.log(`$env:TERMTERM_SSH_USER='${USER}'; $env:TERMTERM_SSH_KEY='${localKey}'`)
  console.log(`$env:TERMTERM_SSH_HOST_KEY='${localHostPublicKey}'; $env:TERMTERM_SSH_PASSWORD='${PASSWORD}'`)
  console.log('npm run verify:sftp')
}

function stop() {
  wsl(`pkill -F ${WORK}/sshd.pid 2>/dev/null || true; echo stopped`)
  console.log('fixture stopped')
}

const action = process.argv[2] || 'start'
if (action === 'stop') stop()
else if (action === 'start') start()
else {
  console.error('usage: node scripts/sshd-fixture.cjs [start|stop]')
  process.exit(2)
}
