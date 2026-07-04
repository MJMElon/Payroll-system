import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { isSupabaseConfigured } from './lib/supabase'
import App from './App'
import './index.css'

// Shown instead of the app when the Supabase env vars are missing, so a
// misconfigured build explains itself rather than rendering a blank page.
function MissingConfig() {
  return (
    <div style={{ maxWidth: '40rem', margin: '4rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif', lineHeight: 1.6 }}>
      <h1>Configuration required</h1>
      <p>
        The app is built without its Supabase settings, so it cannot start.
      </p>
      <ul>
        <li>
          <strong>Running locally:</strong> copy <code>.env.example</code> to <code>.env</code>,
          fill in <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code>
          (Supabase → Project Settings → API), then restart <code>npm run dev</code>.
        </li>
        <li>
          <strong>GitHub Pages:</strong> add the same two values as repository secrets under
          Settings → Secrets and variables → Actions, then re-run the deploy workflow.
        </li>
      </ul>
    </div>
  )
}

// HashRouter is used so the app works on GitHub Pages (a static host) without
// needing server-side rewrites for deep links or page refreshes.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isSupabaseConfigured ? (
      <HashRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </HashRouter>
    ) : (
      <MissingConfig />
    )}
  </StrictMode>,
)
