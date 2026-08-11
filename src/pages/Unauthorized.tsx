import { Link } from 'react-router-dom'

export default function Unauthorized() {
  return (
    <div className="center">
      <div className="card auth">
        <h1>No access</h1>
        <p className="muted">You don't have access to this page.</p>
        <Link className="btn ghost" to="/">
          Back to dashboard
        </Link>
      </div>
    </div>
  )
}
