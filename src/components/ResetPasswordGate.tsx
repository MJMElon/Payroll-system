import { useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'

// Shown on top of everything when the user arrives from a password-reset
// email (Supabase PASSWORD_RECOVERY event). They set a new password here
// and continue signed in.
export default function ResetPasswordGate() {
  const { passwordRecovery, clearPasswordRecovery } = useAuth()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  if (!passwordRecovery) return null

  async function save(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (password.length < 6) return setError('Password must be at least 6 characters.')
    if (password !== confirm) return setError('Passwords do not match.')
    setSaving(true)
    const { error } = await supabase.auth.updateUser({ password })
    setSaving(false)
    if (error) return setError(error.message)
    clearPasswordRecovery()
  }

  return (
    <div className="modal-overlay" style={{ zIndex: 100 }}>
      <form className="modal" onSubmit={save}>
        <h2>Set a new password</h2>
        <p className="muted small" style={{ margin: 0 }}>
          You opened a password-reset link. Choose a new password to continue.
        </p>
        {error && <div className="error">{error}</div>}
        <label className="field">
          <span>New password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            autoFocus
            required
          />
        </label>
        <label className="field">
          <span>Repeat new password</span>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        <div className="row-form" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save new password'}
          </button>
        </div>
      </form>
    </div>
  )
}
