/**
 * Reads the one-time tokens Supabase puts in the URL when someone opens a
 * password-reset (or email-confirmation) link, and takes them out of the
 * address bar.
 *
 * Supabase's default auth flow is "implicit": after it verifies the emailed
 * token it redirects to
 *
 *   https://<site>/<base>/#access_token=...&refresh_token=...&type=recovery
 *
 * The app routes with HashRouter, so that same fragment is also where routes
 * live. `#access_token=...` matches no route, the catch-all sends the browser
 * to `#/`, and the tokens are gone before supabase-js has read them — the
 * reset link then does nothing at all.
 *
 * So this module runs at import time, before any React or router code, grabs
 * whatever the link carried, and rewrites the address to a plain `#/`.
 * AuthContext applies the tokens with setSession() once it mounts.
 */

export interface AuthLink {
  accessToken: string | null
  refreshToken: string | null
  /** 'recovery' for a reset link, 'signup'/'magiclink'/'invite' otherwise. */
  type: string | null
  /** Set when the link itself failed — expired, already used, revoked. */
  error: string | null
}

function pick(params: URLSearchParams): AuthLink | null {
  const accessToken = params.get('access_token')
  const error = params.get('error_description') || params.get('error')
  if (!accessToken && !error) return null
  return {
    accessToken,
    refreshToken: params.get('refresh_token'),
    type: params.get('type'),
    // Supabase sends these URL-encoded with '+' for spaces.
    error: error ? error.replace(/\+/g, ' ') : null,
  }
}

function read(): AuthLink | null {
  if (typeof window === 'undefined') return null
  const raw = window.location.hash.slice(1)
  // "#/settings" is a route, not an auth payload.
  const fromHash = raw && !raw.startsWith('/') ? pick(new URLSearchParams(raw)) : null
  // Some Supabase setups return the error on the query string instead.
  const link = fromHash ?? pick(new URLSearchParams(window.location.search))
  if (link) {
    // Land on a route the router understands, and keep single-use tokens out
    // of browser history.
    window.history.replaceState(null, '', window.location.pathname + '#/')
  }
  return link
}

export const authLink = read()
