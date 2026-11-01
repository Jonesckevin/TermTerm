import { useEffect } from 'react'
import type { ReactNode } from 'react'

export interface DialogChoice {
  label: string
  hint?: string
  tone?: 'primary' | 'danger'
  onSelect: () => void
}

interface Props {
  open: boolean
  title: string
  body: ReactNode
  choices: DialogChoice[]
  onClose: () => void
}

/** Small modal used for destructive choices that need more than yes/no. */
export function ConfirmDialog({ open, title, body, choices, onClose }: Props) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div
        className="dialog confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <h2>{title}</h2>
        </header>

        <div className="confirm-body">{body}</div>

        <div className="dialog-actions">
          {choices.map((choice) => (
            <button
              key={choice.label}
              type="button"
              className={`choice-button ${choice.tone ?? 'primary'}`}
              onClick={() => {
                choice.onSelect()
                onClose()
              }}
            >
              <span className="choice-label">{choice.label}</span>
              {choice.hint ? <span className="choice-hint">{choice.hint}</span> : null}
            </button>
          ))}
          <button type="button" className="ghost-button cancel-choice" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
