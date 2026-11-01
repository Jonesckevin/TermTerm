import type { VaultStatus } from '@shared/types'
import { useAppStore } from '@/state/useAppStore'
import { GridIcon, HelpIcon, LockIcon, PlusIcon, UnlockIcon } from './icons'
import { useState } from 'react'

interface WorkspacePreset {
  camera: { x: number; y: number; zoom: number }
  nodes: Array<{ id: string; x: number; y: number }>
}

const PRESET_STORAGE_KEY = 'termterm.workspace-presets'

interface Props {
  onNewTerminal: () => void
  vault: VaultStatus
  onLock: () => void
  onUnlock: () => void
  onHelp: () => void
  onKanban: () => void
}

export function TitleBar({ onNewTerminal, vault, onLock, onUnlock, onHelp, onKanban }: Props) {
  const [presetName, setPresetName] = useState('')
  const nodes = useAppStore((state) => state.nodes)
  const running = useAppStore(
    (state) => Object.values(state.statuses).filter((status) => status === 'running').length
  )
  const platformClass = navigator.userAgent.includes('Mac') ? 'mac' : 'win'
  const vaultLabel = !vault.exists ? 'No vault' : vault.unlocked ? 'Vault unlocked' : 'Vault locked'

  const savedPresets = (): Record<string, WorkspacePreset> => {
    try {
      return JSON.parse(localStorage.getItem(PRESET_STORAGE_KEY) ?? '{}') as Record<string, WorkspacePreset>
    } catch {
      return {}
    }
  }

  const savePreset = (): void => {
    const name = presetName.trim() || window.prompt('Workspace preset name', 'My workspace')?.trim()
    if (!name) return
    const state = useAppStore.getState()
    const presets = savedPresets()
    presets[name] = {
      camera: state.camera,
      nodes: state.nodes.map(({ id, x, y }) => ({ id, x, y }))
    }
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets))
    setPresetName(name)
  }

  const restorePreset = (name: string): void => {
    const preset = savedPresets()[name]
    if (!preset) return
    const state = useAppStore.getState()
    state.nodes.forEach((node) => {
      const savedNode = preset.nodes.find((candidate) => candidate.id === node.id)
      if (savedNode) state.updateNode(node.id, { x: savedNode.x, y: savedNode.y })
    })
    state.setCamera(preset.camera)
  }

  return (
    <header className={`titlebar ${platformClass}`}>
      <div className="titlebar-brand">
        <span className="brand-mark">
          <GridIcon size={14} />
        </span>
        <span className="brand-name">TermTerm</span>
        <span className="brand-badge">alpha</span>
      </div>

      <div className="titlebar-center">
        <span className="titlebar-stat">
          {nodes.length} terminal{nodes.length === 1 ? '' : 's'}
        </span>
        <span className="titlebar-stat dim">{running} live</span>
      </div>

      <div className="titlebar-actions">
        <button type="button" className="ghost-button" title="Open session board" onClick={onKanban}>
          Board
        </button>
        <input
          className="preset-name"
          value={presetName}
          aria-label="Workspace preset name"
          placeholder="Preset"
          list="workspace-presets"
          onChange={(event) => setPresetName(event.target.value)}
        />
        <datalist id="workspace-presets">
          {Object.keys(savedPresets()).map((name) => <option key={name} value={name} />)}
        </datalist>
        <button type="button" className="ghost-button" title="Save workspace preset" onClick={savePreset}>
          Save
        </button>
        <button
          type="button"
          className="ghost-button"
          title="Restore named workspace preset"
          disabled={!savedPresets()[presetName]}
          onClick={() => restorePreset(presetName)}
        >
          Restore
        </button>
        <button type="button" className="ghost-button help-button" title="Help (F1)" onClick={onHelp}>
          <HelpIcon size={14} />
          <span>Help</span>
        </button>

        {vault.exists ? (
          <button
            type="button"
            className={`vault-button${vault.unlocked ? ' unlocked' : ''}`}
            title={vault.unlocked ? 'Lock the vault (Ctrl+Shift+L)' : 'Unlock saved connections'}
            onClick={vault.unlocked ? onLock : onUnlock}
          >
            {vault.unlocked ? <UnlockIcon size={13} /> : <LockIcon size={13} />}
            <span>{vaultLabel}</span>
          </button>
        ) : null}

        <button type="button" className="ghost-button" onClick={onNewTerminal}>
          <PlusIcon size={14} />
          <span>New terminal</span>
        </button>
      </div>
    </header>
  )
}
