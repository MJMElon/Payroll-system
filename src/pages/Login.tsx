import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'

type Mode = 'signin' | 'signup'

export default function Login() {
  const { session, signIn, loading } = useAuth()
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (!loading && session) return <Navigate to="/" replace />

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setInfo(null)
    setSubmitting(true)
    if (mode === 'signin') {
      const { error } = await signIn(email, password)
      if (error) setError(error)
    } else {
      const { data, error } = await supabase.auth.signUp({ email, password })
      if (error) {
        setError(error.message)
      } else if (!data.session) {
        // Email confirmation is enabled in Supabase: no session until confirmed.
        setInfo('Account created. Check your email to confirm, then sign in.')
        setMode('signin')
      }
    }
    setSubmitting(false)
  }

  function switchMode(next: Mode) {
    setMode(next)
    setError(null)
    setInfo(null)
  }

  return (
    <div className="login-screen">
      <div className="login-lines" aria-hidden="true">
        <span className="h l1" />
        <span className="h l2" />
        <span className="h l3" />
        <span className="v l4" />
        <span className="v l5" />
        <span className="v l6" />
      </div>

      <form className="login-card" onSubmit={onSubmit}>
        <span className="login-corner tl" aria-hidden="true" />
        <span className="login-corner tr" aria-hidden="true" />
        <span className="login-corner bl" aria-hidden="true" />
        <span className="login-corner br" aria-hidden="true" />

        <h1 className="login-title">MJM</h1>
        <p className="login-tagline">THE FUTURE IS HERE</p>

        <input
          className="login-input"
          type="email"
          placeholder="Email"
          aria-label="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
        />
        <input
          className="login-input"
          type="password"
          placeholder="Password"
          aria-label="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
          required
        />

        {error && <div className="login-msg error">{error}</div>}
        {info && <div className="login-msg info">{info}</div>}

        <button className="login-btn" type="submit" disabled={submitting}>
          {submitting ? 'PLEASE WAIT…' : mode === 'signin' ? 'LOGIN' : 'CREATE ACCOUNT'}
        </button>

        <div className="login-links">
          <button
            type="button"
            className="forgot"
            onClick={() =>
              setInfo('Password reset is not set up yet — ask your administrator to reset it in Supabase.')
            }
          >
            FORGOT PASSWORD?
          </button>
          {mode === 'signin' ? (
            <button type="button" className="create" onClick={() => switchMode('signup')}>
              CREATE ACCOUNT
            </button>
          ) : (
            <button type="button" className="create" onClick={() => switchMode('signin')}>
              BACK TO LOGIN
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
