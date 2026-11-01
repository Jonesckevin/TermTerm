import { app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, shell } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { writeFileSync } from 'node:fs'
import type {
  ConnectionInput,
  PersistedLayout,
  ShellProfile,
  SftpResult,
  SpawnRequest,
  VaultStatus
} from '../shared/types'
import { loadLayout, saveLayout } from './persistence'
import { listProfiles, setCustomProfilesPath } from './pty/profiles'
import { SessionManager } from './sessions/manager'
import { HostKeyError, SftpService } from './ssh/sftp'
import {
  assertConnectionId,
  assertConnectionInput,
  assertFingerprint,
  assertLocalPath,
  assertLocalPaths,
  assertMasterPassword,
  assertNodeId,
  assertRemoteName,
  assertRemotePath,
  assertSftpKind,
  assertSpawnRequest,
  assertTerminalData,
  InvalidInputError
} from './validation'
import { InvalidPasswordError, Vault, vaultPath } from './vault'
import { x11Status } from './x11'

const isDev = !app.isPackaged
let mainWindow: BrowserWindow | null = null
let profiles: ShellProfile[] = []

// The portable launcher sets PORTABLE_EXECUTABLE_DIR. Keeping userData beside the
// exe means layout, shell profiles and settings travel with the single file.
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
if (portableDir) {
  app.setPath('userData', join(portableDir, 'TermTerm-data'))
}

const vault = new Vault(vaultPath(app.getPath('userData')))

// SFTP sessions live beside the vault: only the keys the user has approved are
// written to disk, in TermTerm's own known_hosts next to the encrypted vault.
const sftp = new SftpService(vault, join(app.getPath('userData'), 'known_hosts'), [
  join(homedir(), '.ssh', 'known_hosts'),
  join(homedir(), '.ssh', 'known_hosts2')
])

let failedUnlocks = 0
let lastUnlockAttempt = 0

function refreshProfiles(): ShellProfile[] {
  profiles = listProfiles()
  return profiles
}

function findProfile(profileId: string): ShellProfile | undefined {
  return profiles.find((profile) => profile.id === profileId)
}

/** IPC is only honoured from our own window's renderer. */
function assertTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): void {
  const contents = mainWindow?.webContents
  if (!contents || event.sender.id !== contents.id) throw new Error('Untrusted IPC sender')
}

async function guardedUnlock(password: string): Promise<VaultStatus> {
  // scrypt already makes guessing expensive; this also slows scripted retries.
  const backoff = failedUnlocks >= 5 ? Math.min(30_000, 1000 * 2 ** (failedUnlocks - 5)) : 0
  const wait = Math.max(0, lastUnlockAttempt + 400 + backoff - Date.now())
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  lastUnlockAttempt = Date.now()

  try {
    const status = vault.unlock(password)
    failedUnlocks = 0
    return status
  } catch (error) {
    if (error instanceof InvalidPasswordError) failedUnlocks += 1
    throw error
  }
}

function lockVault(): void {
  sftp.disconnectAll()
  const status = vault.lock()
  mainWindow?.webContents.send('vault:locked', status)
}

/**
 * SFTP failures are returned as data so the UI can offer to trust a new host key
 * instead of surfacing an opaque IPC error.
 */
async function sftpCall<T>(run: () => Promise<T>): Promise<SftpResult<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    if (error instanceof HostKeyError) {
      // Only an unknown key can be approved; a changed key is always an error.
      return error.verdict === 'unknown'
        ? { ok: false, error: error.message, hostKey: error.challenge }
        : { ok: false, error: error.message }
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#141417',
    title: 'TermTerm',
    icon: join(__dirname, '../../build/icon.png'),
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: 14 } }
      : { titleBarOverlay: { color: '#141417', symbolColor: '#c9c9cf', height: 40 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Renderer shows a continuous stream of untrusted shell/SSH/Telnet output.
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Keep the terminal app self-contained: links open in the user's browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
  })
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (isDev && devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(sessions: SessionManager): void {
  ipcMain.handle('profiles:list', (event) => {
    assertTrustedSender(event)
    return profiles.length > 0 ? profiles : refreshProfiles()
  })
  ipcMain.handle('profiles:refresh', (event) => {
    assertTrustedSender(event)
    return refreshProfiles()
  })

  ipcMain.handle('pty:spawn', (event, raw: unknown) => {
    assertTrustedSender(event)
    const request: SpawnRequest = assertSpawnRequest(raw)
    return sessions.spawn(request)
  })
  ipcMain.on('pty:write', (event, rawNodeId: unknown, rawData: unknown) => {
    assertTrustedSender(event)
    sessions.write(assertNodeId(rawNodeId), assertTerminalData(rawData))
  })
  ipcMain.on('pty:resize', (event, rawNodeId: unknown, cols: unknown, rows: unknown) => {
    assertTrustedSender(event)
    sessions.resize(assertNodeId(rawNodeId), Number(cols) || 0, Number(rows) || 0)
  })
  ipcMain.on('pty:kill', (event, rawNodeId: unknown) => {
    assertTrustedSender(event)
    sessions.kill(assertNodeId(rawNodeId))
  })

  ipcMain.handle('layout:load', (event) => {
    assertTrustedSender(event)
    return loadLayout()
  })
  ipcMain.on('layout:save', (event, layout: PersistedLayout) => {
    assertTrustedSender(event)
    try {
      saveLayout(layout)
    } catch (error) {
      console.error('Failed to persist layout', error)
    }
  })

  ipcMain.handle('dialog:pick-directory', async (event) => {
    assertTrustedSender(event)
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a starting directory',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('terminal:export', async (event, rawContent: unknown, rawSuggestedName: unknown) => {
    assertTrustedSender(event)
    if (typeof rawContent !== 'string' || rawContent.length > 300_000) {
      throw new InvalidInputError('Invalid terminal export')
    }
    if (typeof rawSuggestedName !== 'string' || rawSuggestedName.length > 120) {
      throw new InvalidInputError('Invalid export filename')
    }
    if (!mainWindow) return null
    const suggestedName = rawSuggestedName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-') || 'terminal.txt'
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export terminal scrollback',
      defaultPath: `${suggestedName}.txt`,
      filters: [
        { name: 'Text files', extensions: ['txt'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePath) return null
    writeFileSync(assertLocalPath(result.filePath), rawContent, 'utf8')
    return result.filePath
  })

  ipcMain.handle('vault:status', (event) => {
    assertTrustedSender(event)
    return vault.status()
  })
  ipcMain.handle('vault:create', (event, password: unknown) => {
    assertTrustedSender(event)
    failedUnlocks = 0
    return vault.create(assertMasterPassword(password))
  })
  ipcMain.handle('vault:unlock', (event, password: unknown) => {
    assertTrustedSender(event)
    if (typeof password !== 'string' || password.length === 0 || password.length > 512) {
      throw new InvalidInputError('Enter your master password')
    }
    return guardedUnlock(password)
  })
  ipcMain.handle('vault:lock', (event) => {
    assertTrustedSender(event)
    return vault.lock()
  })

  ipcMain.handle('connections:list', (event) => {
    assertTrustedSender(event)
    return vault.connections()
  })
  ipcMain.handle('connections:save', (event, raw: unknown) => {
    assertTrustedSender(event)
    const input: ConnectionInput = assertConnectionInput(raw)
    return vault.upsert(input)
  })
  ipcMain.handle('connections:delete', (event, rawId: unknown) => {
    assertTrustedSender(event)
    return vault.remove(assertNodeId(rawId))
  })

  ipcMain.handle('x11:status', (event) => {
    assertTrustedSender(event)
    return x11Status()
  })

  ipcMain.handle('sftp:list', (event, rawId: unknown, rawPath: unknown) => {
    assertTrustedSender(event)
    const connectionId = assertConnectionId(rawId)
    const path = rawPath === undefined || rawPath === null || rawPath === '' ? undefined : assertRemotePath(rawPath)
    return sftpCall(() => sftp.list(connectionId, path))
  })
  ipcMain.handle('sftp:stat', (event, rawId: unknown, rawPath: unknown) => {
    assertTrustedSender(event)
    const connectionId = assertConnectionId(rawId)
    const path = assertRemotePath(rawPath)
    return sftpCall(() => sftp.stat(connectionId, path))
  })
  ipcMain.handle('sftp:mkdir', (event, rawId: unknown, rawDirectory: unknown, rawName: unknown) => {
    assertTrustedSender(event)
    const connectionId = assertConnectionId(rawId)
    const directory = assertRemotePath(rawDirectory)
    const name = assertRemoteName(rawName)
    return sftpCall(() => sftp.makeDirectory(connectionId, directory, name))
  })
  ipcMain.handle('sftp:rename', (event, rawId: unknown, rawPath: unknown, rawName: unknown) => {
    assertTrustedSender(event)
    const connectionId = assertConnectionId(rawId)
    const path = assertRemotePath(rawPath)
    const name = assertRemoteName(rawName)
    return sftpCall(() => sftp.rename(connectionId, path, name))
  })
  ipcMain.handle('sftp:remove', (event, rawId: unknown, rawPath: unknown, rawKind: unknown) => {
    assertTrustedSender(event)
    const connectionId = assertConnectionId(rawId)
    const path = assertRemotePath(rawPath)
    const kind = assertSftpKind(rawKind)
    return sftpCall(() => sftp.remove(connectionId, path, kind))
  })
  ipcMain.handle('sftp:download', async (event, rawId: unknown, rawPath: unknown, rawLocal: unknown) => {
    assertTrustedSender(event)
    const connectionId = assertConnectionId(rawId)
    const path = assertRemotePath(rawPath)
    let localPath: string
    if (rawLocal === undefined || rawLocal === null || rawLocal === '') {
      if (!mainWindow) return { ok: false, error: 'No window is available' } as SftpResult<never>
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Download from the remote host',
        defaultPath: basename(path)
      })
      if (result.canceled || !result.filePath) return { ok: true, value: null } as SftpResult<null>
      localPath = result.filePath
    } else {
      localPath = assertLocalPath(rawLocal)
    }
    return sftpCall(() => sftp.download(connectionId, path, localPath))
  })
  ipcMain.handle('sftp:upload', async (event, rawId: unknown, rawDirectory: unknown) => {
    assertTrustedSender(event)
    const connectionId = assertConnectionId(rawId)
    const directory = assertRemotePath(rawDirectory)
    if (!mainWindow) return { ok: false, error: 'No window is available' } as SftpResult<never>
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Upload to the remote host',
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: true, value: { directory, uploaded: [] } } as SftpResult<never>
    }
    const paths = result.filePaths.map((filePath) => assertLocalPath(filePath))
    return sftpCall(() => sftp.upload(connectionId, directory, paths))
  })
  ipcMain.handle('sftp:upload-files', (event, rawId: unknown, rawDirectory: unknown, rawPaths: unknown) => {
    assertTrustedSender(event)
    const connectionId = assertConnectionId(rawId)
    const directory = assertRemotePath(rawDirectory)
    const paths = assertLocalPaths(rawPaths)
    return sftpCall(() => sftp.upload(connectionId, directory, paths))
  })
  ipcMain.handle('sftp:trust-host', (event, rawId: unknown, rawFingerprint: unknown) => {
    assertTrustedSender(event)
    const connectionId = assertConnectionId(rawId)
    const fingerprint = assertFingerprint(rawFingerprint)
    return sftpCall(async () => {
      sftp.trustHost(connectionId, fingerprint)
      return null
    })
  })
  ipcMain.on('sftp:disconnect', (event, rawId: unknown) => {
    assertTrustedSender(event)
    sftp.disconnect(assertConnectionId(rawId))
  })
}

function buildMenu(): void {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        {
          label: 'View',
          submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }]
        },
        { role: 'windowMenu' }
      ])
    )
    return
  }
  Menu.setApplicationMenu(null)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    app.setAppUserModelId('dev.termterm.app')
    setCustomProfilesPath(join(app.getPath('userData'), 'profiles.json'))
    refreshProfiles()
    buildMenu()

    const sessions = new SessionManager(
      (channel, payload) => mainWindow?.webContents.send(channel, payload),
      findProfile,
      vault,
      join(app.getAppPath(), 'scripts/session-host.cjs')
    )

    registerIpc(sessions)
    createWindow()

    // Lock the vault when the machine sleeps so decrypted secrets do not linger.
    powerMonitor.on('suspend', () => lockVault())

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
    app.on('before-quit', () => {
      sessions.killAll()
      // Without this the detached host outlives the app and holds its port.
      sessions.shutdownHost()
      sftp.disconnectAll()
      vault.lock()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
