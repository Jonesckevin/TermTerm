export type ProfileKind = 'powershell' | 'cmd' | 'wsl' | 'unix' | 'shell' | 'container' | 'ssh' | 'custom'

export type ConnectionKind = 'ssh' | 'telnet' | 'rdp'

export type NodeKind = 'terminal' | 'note' | 'editor' | 'diff'

export interface ShellProfile {
  /** Stable identifier used as the persisted profile reference. */
  id: string
  /** Display name, e.g. `PowerShell 7`, `Ubuntu (WSL)`, `ssh build-box`. */
  name: string
  kind: ProfileKind
  /** 1-3 character monogram shown in the node avatar. */
  badge: string
  /** Accent colour for the avatar and node stripe. */
  accent: string
  /** Secondary line in the picker, e.g. the executable path or distro name. */
  detail?: string
  /** True for the platform default shell (`$SHELL`). */
  isDefault?: boolean
  /** Whether the executable backing this profile exists on this machine. */
  available: boolean
}

export interface Camera {
  x: number
  y: number
  zoom: number
}

/** A node group in the sidebar tree. Hiding a layer hides every node inside it. */
export interface Layer {
  id: string
  name: string
  parentId: string | null
  visible: boolean
  collapsed: boolean
}

export interface TerminalNodeModel {
  id: string
  title: string
  /** True when the user renamed the node; otherwise the title is derived (never a hostname). */
  titleCustom?: boolean
  layerId: string
  /** Defaults to `terminal`; notes carry text instead of a session. */
  kind?: NodeKind
  /** Sticky-note body (only for `kind: 'note'`). */
  text?: string
  /** Local text used by editor and diff nodes. */
  filePath?: string
  diff?: string
  /** Sticky-note colour (only for `kind: 'note'`). */
  color?: string
  /** Local shell profile (PowerShell, cmd, WSL, ...); mutually exclusive with connectionId. */
  profileId?: string
  /** Saved vault connection (ssh / telnet / rdp); mutually exclusive with profileId. */
  connectionId?: string
  x: number
  y: number
  w: number
  h: number
  /** Working directory the shell was last started in (used to restore sessions). */
  cwd?: string
  /** Recent terminal output retained across app restarts. */
  scrollback?: string
  /** Separate PTY session displayed beside the primary terminal in this node. */
  splitPaneId?: string
}

/** A visual link between two nodes (drag from a node port to another node). */
export interface NodeLink {
  id: string
  from: string
  to: string
}

/**
 * A saved connection. Stored inside the encrypted vault – never in layout.json –
 * so hostnames and usernames are protected along with any password.
 */
export interface SavedConnection {
  id: string
  name: string
  kind: ConnectionKind
  host: string
  port?: number
  username?: string
  identityFile?: string
  x11?: boolean
  x11Trusted?: boolean
  badge: string
  accent: string
  /** True when a password is held in the vault for this connection. */
  hasSecret: boolean
}

export interface ConnectionInput {
  id?: string
  name: string
  kind: ConnectionKind
  host: string
  port?: number
  username?: string
  identityFile?: string
  x11?: boolean
  x11Trusted?: boolean
  /** Omit to keep the existing secret; `null` clears it. */
  password?: string | null
}

export interface VaultStatus {
  exists: boolean
  unlocked: boolean
  connectionCount: number
}

export interface X11Status {
  available: boolean
  detail: string
}

/** One row in the remote file browser. */
export interface SftpEntry {
  name: string
  path: string
  kind: 'dir' | 'file' | 'link'
  size: number
  modified: number
}

export interface SftpListing {
  path: string
  /** Login directory, used as the starting point for a new panel. */
  home: string
  entries: SftpEntry[]
}

export interface SftpUploadResult {
  directory: string
  uploaded: { name: string; size: number }[]
}

/** What the UI needs to show (and approve) an untrusted host key. */
export interface SftpHostKeyChallenge {
  host: string
  keyType: string
  fingerprint: string
}

/**
 * SFTP calls report failures as data instead of throwing, because an untrusted
 * host key is a normal step in the flow rather than an exception.
 */
export type SftpResult<T> = { ok: true; value: T } | { ok: false; error: string; hostKey?: SftpHostKeyChallenge }

export interface PersistedLayout {
  version: number
  nodes: TerminalNodeModel[]
  layers: Layer[]
  links: NodeLink[]
  camera: Camera
}

export interface SpawnRequest {
  nodeId: string
  profileId?: string
  connectionId?: string
  cwd?: string
  cols: number
  rows: number
}

export interface SpawnResult {
  nodeId: string
  pid: number
  /** Shell profile id, or empty for connection nodes. */
  profileId: string
  /** Directory explicitly requested at spawn time; empty when the shell picked its own start directory. */
  cwd: string
  /** Non-fatal notice shown at the top of the terminal (e.g. missing X server). */
  warning?: string
  /** True when the session opens in an external window instead of the terminal (RDP). */
  external?: boolean
  /** Populated for external sessions so the node can show what was launched. */
  launched?: string
  /** Output replay retained while a session is alive and its renderer is reattaching. */
  replay?: string
}

export interface PtyDataEvent {
  nodeId: string
  data: string
}

export interface PtyExitEvent {
  nodeId: string
  exitCode: number
  signal?: number
}

export interface TermTermApi {
  platform: string
  listProfiles: () => Promise<ShellProfile[]>
  /** Re-runs detection, so containers that started since launch show up. */
  refreshProfiles: () => Promise<ShellProfile[]>
  spawn: (req: SpawnRequest) => Promise<SpawnResult>
  write: (nodeId: string, data: string) => void
  resize: (nodeId: string, cols: number, rows: number) => void
  kill: (nodeId: string) => void
  onData: (cb: (event: PtyDataEvent) => void) => () => void
  onExit: (cb: (event: PtyExitEvent) => void) => () => void
  loadLayout: () => Promise<PersistedLayout | null>
  saveLayout: (layout: PersistedLayout) => void
  pickDirectory: () => Promise<string | null>
  exportTerminal: (content: string, suggestedName: string) => Promise<string | null>

  vaultStatus: () => Promise<VaultStatus>
  vaultCreate: (password: string) => Promise<VaultStatus>
  vaultUnlock: (password: string) => Promise<VaultStatus>
  vaultLock: () => Promise<VaultStatus>
  listConnections: () => Promise<SavedConnection[]>
  saveConnection: (input: ConnectionInput) => Promise<SavedConnection[]>
  deleteConnection: (id: string) => Promise<SavedConnection[]>
  x11Status: () => Promise<X11Status>

  /** SFTP file browser for saved SSH connections. */
  sftpList: (connectionId: string, path?: string) => Promise<SftpResult<SftpListing>>
  sftpStat: (connectionId: string, path: string) => Promise<SftpResult<SftpEntry>>
  sftpMkdir: (connectionId: string, directory: string, name: string) => Promise<SftpResult<string>>
  sftpRename: (connectionId: string, path: string, name: string) => Promise<SftpResult<string>>
  sftpRemove: (connectionId: string, path: string, kind: SftpEntry['kind']) => Promise<SftpResult<number>>
  /** Resolves to `null` when the save dialog is dismissed. */
  sftpDownload: (
    connectionId: string,
    remotePath: string,
    localPath?: string
  ) => Promise<SftpResult<{ path: string; size: number } | null>>
  /** Resolves to an empty list when the open dialog is dismissed. */
  sftpUpload: (connectionId: string, remoteDirectory: string) => Promise<SftpResult<SftpUploadResult>>
  sftpUploadFiles: (
    connectionId: string,
    remoteDirectory: string,
    localPaths: string[]
  ) => Promise<SftpResult<SftpUploadResult>>
  sftpTrustHost: (connectionId: string, fingerprint: string) => Promise<SftpResult<null>>
  sftpDisconnect: (connectionId: string) => void
  /** Absolute local path of a dropped file (Electron hides `File.path`). */
  pathForFile: (file: File) => string
}
