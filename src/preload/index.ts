import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  ConnectionInput,
  PersistedLayout,
  PtyDataEvent,
  PtyExitEvent,
  SftpEntry,
  SpawnRequest,
  TermTermApi,
  VaultStatus
} from '../shared/types'

const api: TermTermApi = {
  platform: process.platform,
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  refreshProfiles: () => ipcRenderer.invoke('profiles:refresh'),
  spawn: (request: SpawnRequest) => ipcRenderer.invoke('pty:spawn', request),
  write: (nodeId, data) => ipcRenderer.send('pty:write', nodeId, data),
  resize: (nodeId, cols, rows) => ipcRenderer.send('pty:resize', nodeId, cols, rows),
  kill: (nodeId) => ipcRenderer.send('pty:kill', nodeId),
  onData: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: PtyDataEvent): void => cb(payload)
    ipcRenderer.on('pty:data', listener)
    return () => ipcRenderer.removeListener('pty:data', listener)
  },
  onExit: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: PtyExitEvent): void => cb(payload)
    ipcRenderer.on('pty:exit', listener)
    return () => ipcRenderer.removeListener('pty:exit', listener)
  },
  loadLayout: () => ipcRenderer.invoke('layout:load') as Promise<PersistedLayout | null>,
  saveLayout: (layout) => ipcRenderer.send('layout:save', layout),
  pickDirectory: () => ipcRenderer.invoke('dialog:pick-directory'),
  exportTerminal: (content, suggestedName) =>
    ipcRenderer.invoke('terminal:export', content, suggestedName),

  vaultStatus: () => ipcRenderer.invoke('vault:status'),
  vaultCreate: (password) => ipcRenderer.invoke('vault:create', password),
  vaultUnlock: (password) => ipcRenderer.invoke('vault:unlock', password),
  vaultLock: () => ipcRenderer.invoke('vault:lock'),
  listConnections: () => ipcRenderer.invoke('connections:list'),
  saveConnection: (input: ConnectionInput) => ipcRenderer.invoke('connections:save', input),
  deleteConnection: (id: string) => ipcRenderer.invoke('connections:delete', id),
  x11Status: () => ipcRenderer.invoke('x11:status'),

  sftpList: (connectionId: string, path?: string) => ipcRenderer.invoke('sftp:list', connectionId, path),
  sftpStat: (connectionId: string, path: string) => ipcRenderer.invoke('sftp:stat', connectionId, path),
  sftpMkdir: (connectionId: string, directory: string, name: string) =>
    ipcRenderer.invoke('sftp:mkdir', connectionId, directory, name),
  sftpRename: (connectionId: string, path: string, name: string) =>
    ipcRenderer.invoke('sftp:rename', connectionId, path, name),
  sftpRemove: (connectionId: string, path: string, kind: SftpEntry['kind']) =>
    ipcRenderer.invoke('sftp:remove', connectionId, path, kind),
  sftpDownload: (connectionId: string, remotePath: string, localPath?: string) =>
    ipcRenderer.invoke('sftp:download', connectionId, remotePath, localPath),
  sftpUpload: (connectionId: string, remoteDirectory: string) =>
    ipcRenderer.invoke('sftp:upload', connectionId, remoteDirectory),
  sftpUploadFiles: (connectionId: string, remoteDirectory: string, localPaths: string[]) =>
    ipcRenderer.invoke('sftp:upload-files', connectionId, remoteDirectory, localPaths),
  sftpTrustHost: (connectionId: string, fingerprint: string) =>
    ipcRenderer.invoke('sftp:trust-host', connectionId, fingerprint),
  sftpDisconnect: (connectionId: string) => ipcRenderer.send('sftp:disconnect', connectionId),
  pathForFile: (file: File) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('termterm', api)

contextBridge.exposeInMainWorld('termtermEvents', {
  onVaultLocked: (cb: (status: VaultStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: VaultStatus): void => cb(payload)
    ipcRenderer.on('vault:locked', listener)
    return () => ipcRenderer.removeListener('vault:locked', listener)
  }
})
