import type { TermTermApi, VaultStatus } from '../shared/types'

declare global {
  interface Window {
    termterm: TermTermApi
    termtermEvents: {
      onVaultLocked: (cb: (status: VaultStatus) => void) => () => void
    }
  }
}

export {}
