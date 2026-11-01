import { useEffect, useRef, useState } from 'react'
import { LockIcon, ShieldIcon } from './icons'

interface Props {
  mode: 'create' | 'unlock'
  busy: boolean
  error?: string | null
  onSubmit: (password: string) => void
  onSkip: () => void
}

export function LockScreen({ mode, busy, error, onSubmit, onSkip }: Props) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = (): void => {
    if (busy) return
    if (mode === 'create') {
      if (password.length < 8) {
        setLocalError('Use at least 8 characters.')
        return
      }
      if (password !== confirm) {
        setLocalError('The two passwords do not match.')
        return
      }
    }
    setLocalError(null)
    onSubmit(password)
    setPassword('')
    setConfirm('')
  }

  const message = localError ?? error

  return (
    <div className="lock-screen">
      <form
        className="lock-card"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div className="lock-mark">
          <LockIcon size={22} />
        </div>
        <h1>{mode === 'create' ? 'Protect your connections' : 'Unlock TermTerm'}</h1>
        <p className="lock-lede">
          {mode === 'create'
            ? 'Set a master password to encrypt saved SSH, Telnet and RDP connections on this device.'
            : 'Enter your master password to load your saved connections.'}
        </p>

        <label className="field">
          <span>Master password</span>
          <input
            ref={inputRef}
            type="password"
            value={password}
            autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
            spellCheck={false}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={mode === 'create' ? 'At least 8 characters' : 'Master password'}
          />
        </label>

        {mode === 'create' ? (
          <label className="field">
            <span>Confirm password</span>
            <input
              type="password"
              value={confirm}
              autoComplete="new-password"
              spellCheck={false}
              onChange={(event) => setConfirm(event.target.value)}
              placeholder="Repeat the password"
            />
          </label>
        ) : null}

        {message ? <div className="form-error">{message}</div> : null}

        <button type="submit" className="primary-button" disabled={busy || password.length === 0}>
          {busy ? 'Working…' : mode === 'create' ? 'Create vault' : 'Unlock'}
        </button>

        <button type="button" className="link-button" onClick={onSkip}>
          {mode === 'create' ? 'Skip – no saved connections' : 'Continue without unlocking'}
        </button>

        <p className="lock-footnote">
          <ShieldIcon size={13} />
          AES-256-GCM with a scrypt-derived key. The password itself is never stored or transmitted.
        </p>
      </form>
    </div>
  )
}
